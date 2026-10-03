import { reportClientError } from "../api/telemetry";
import useVoiceStore from "./voiceStore";

// The voice agent's runtime: microphone → provider WebSocket → speaker, plus
// the tool relay and turn persistence. A module-level singleton (not a React
// component) so a conversation survives route changes — Piuma can open a note
// for you mid-sentence without hanging up. Data calls (session, tools, turns)
// are injected by <VoiceProvider> from TanStack Query mutations.
//
// The audio goes straight to the provider (Gemini Live); the backend only mints
// the short-lived session (`ws_url` + the `setup` message), runs every tool
// call, and stores each finished turn in the conversation.

const BASE = import.meta.env.BASE_URL;
const IN_RATE = 16000; // mic → model: PCM16 mono
const OUT_RATE = 24000; // model → speaker: PCM16 mono
const CHUNK_SAMPLES = 640; // 40 ms of mic audio per WebSocket message

const decoder = new TextDecoder();

const store = () => useVoiceStore.getState();
const patch = (p) => useVoiceStore.getState().patch(p);

const int16ToBase64 = (int16) => {
	const bytes = new Uint8Array(
		int16.buffer,
		int16.byteOffset,
		int16.byteLength,
	);
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
};

const base64ToFloat32 = (b64) => {
	const bin = atob(b64);
	const n = bin.length >> 1;
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		let s = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
		if (s >= 0x8000) s -= 0x10000;
		out[i] = s / 0x8000;
	}
	return out;
};

// The exchange in progress: what you said, what Piuma said, the tools it ran,
// its token usage, and how long you waited for the first audio.
const newTurn = () => ({
	user: "",
	piuma: "",
	tools: [],
	interrupted: false,
	tokensIn: 0,
	tokensOut: 0,
	tokensInAudio: 0,
	tokensOutAudio: 0,
	latencyMs: null,
});

// Tokens of one modality in a usage report's per-modality breakdown.
const modalityTokens = (details, modality) =>
	(details || [])
		.filter((d) => d.modality === modality)
		.reduce((sum, d) => sum + (d.tokenCount || 0), 0);

// Voice failures the backend never sees (mic, provider socket, relays) go to
// the shared client telemetry channel.
const report = (type, err, attributes = {}, severity = "error") =>
	reportClientError("voice", err instanceof Error ? err : new Error(err), {
		type,
		severity,
		attributes: { conversation_id: store().conversationId, ...attributes },
	});

const describeError = (err) =>
	err?.response?.data?.error || err?.message || String(err);

class VoiceEngine {
	deps = null;
	ws = null;
	mic = null; // MediaStream
	inCtx = null;
	outCtx = null;
	player = null; // AudioWorkletNode("voice-player")
	analyser = null;
	levelTimer = null;
	pending = []; // Int16 mic samples not yet sent
	resumeHandle = null;
	// The exchange in progress, persisted when the model finishes its turn.
	turn = newTurn();
	// When the provider said your speech ended — the start of the wait for
	// Piuma's first audio (`turn.latencyMs`).
	speechEndedAt = null;
	// Tool calls are non-blocking: the model ends its turn right after calling
	// one and answers in a later turn, once the result is in. The exchange is
	// only saved when no call is outstanding and Piuma has spoken since.
	toolsInFlight = 0;
	spokeSinceTool = true;
	saveChain = Promise.resolve();

	// { startSession, runTool, saveTurn, navigate, focusConversation }
	setDeps(deps) {
		this.deps = deps;
	}

	get active() {
		const s = store().status;
		return s !== "idle" && s !== "error";
	}

	async start() {
		if (this.active || !this.deps) return;
		store().reset();
		this.turn = newTurn();
		this.speechEndedAt = null;
		this.toolsInFlight = 0;
		this.spokeSinceTool = true;
		this.turnFinished = false;
		patch({ status: "connecting" });
		try {
			await this.openAudio();
			await this.connect();
		} catch (err) {
			this.fail(describeError(err));
		}
	}

	stop() {
		this.closeSocket();
		this.closeAudio();
		this.saveTurn();
		this.resumeHandle = null;
		patch({ status: "idle", micLevel: 0, outLevel: 0 });
	}

	setMuted(muted) {
		patch({ muted });
		for (const t of this.mic?.getAudioTracks() || []) t.enabled = !muted;
	}

	fail(message, attributes = {}) {
		report("session_failed", message, {
			status: store().status,
			...attributes,
		});
		this.closeSocket();
		this.closeAudio();
		this.resumeHandle = null;
		patch({ status: "error", error: message, micLevel: 0, outLevel: 0 });
	}

	// ── Audio ────────────────────────────────────────────────────────────────

	async openAudio() {
		this.mic = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
		});

		// Capture: native rate → 16 kHz PCM16 (the recorder's worklet).
		this.inCtx = new AudioContext();
		await this.inCtx.audioWorklet.addModule(`${BASE}recorder-worklet.js`);
		const source = this.inCtx.createMediaStreamSource(this.mic);
		this.analyser = this.inCtx.createAnalyser();
		this.analyser.fftSize = 512;
		source.connect(this.analyser);
		const capture = new AudioWorkletNode(this.inCtx, "pcm16-downsampler", {
			processorOptions: { targetRate: IN_RATE },
		});
		capture.port.onmessage = (e) => this.onMicSamples(new Int16Array(e.data));
		source.connect(capture);
		capture.connect(this.inCtx.destination); // keeps the graph pulling; outputs silence

		// Playback: a context at the model's rate, so no resampling.
		this.outCtx = new AudioContext({ sampleRate: OUT_RATE });
		await this.outCtx.audioWorklet.addModule(`${BASE}voice-player-worklet.js`);
		this.player = new AudioWorkletNode(this.outCtx, "voice-player");
		this.player.port.onmessage = (e) => this.onPlayerEvent(e.data);
		this.player.connect(this.outCtx.destination);

		// Mic loudness for the rings, ~20 Hz.
		const buf = new Float32Array(this.analyser.fftSize);
		this.levelTimer = setInterval(() => {
			if (!this.analyser) return;
			this.analyser.getFloatTimeDomainData(buf);
			let sum = 0;
			for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
			patch({ micLevel: store().muted ? 0 : Math.sqrt(sum / buf.length) });
		}, 50);
	}

	closeAudio() {
		clearInterval(this.levelTimer);
		this.levelTimer = null;
		for (const t of this.mic?.getTracks() || []) t.stop();
		this.mic = null;
		this.inCtx?.close().catch(() => {});
		this.outCtx?.close().catch(() => {});
		this.inCtx = null;
		this.outCtx = null;
		this.player = null;
		this.analyser = null;
		this.pending = [];
	}

	onMicSamples(samples) {
		if (!this.ready || store().muted) return;
		for (let i = 0; i < samples.length; i++) this.pending.push(samples[i]);
		while (this.pending.length >= CHUNK_SAMPLES) {
			const chunk = Int16Array.from(this.pending.splice(0, CHUNK_SAMPLES));
			this.send({
				realtimeInput: {
					audio: {
						data: int16ToBase64(chunk),
						mimeType: `audio/pcm;rate=${IN_RATE}`,
					},
				},
			});
		}
	}

	onPlayerEvent(msg) {
		if (msg.type === "level") {
			patch({ outLevel: msg.rms });
		} else if (msg.type === "drained") {
			patch({ outLevel: 0 });
			if (store().status === "speaking") patch({ status: "listening" });
		}
	}

	// ── Provider socket ─────────────────────────────────────────────────────

	get ready() {
		return this.ws?.readyState === WebSocket.OPEN && this.setupDone;
	}

	send(msg) {
		if (this.ws?.readyState === WebSocket.OPEN)
			this.ws.send(JSON.stringify(msg));
	}

	async connect() {
		const session = await this.deps.startSession({
			conversation_id: store().conversationId,
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			client_now: new Date().toISOString(),
			resume_handle: this.resumeHandle,
		});
		const firstConnect = !store().conversationId;
		patch({
			conversationId: session.conversation_id,
			wakePhrase: session.wake_phrase || null,
		});
		if (firstConnect) this.deps.focusConversation(session.conversation_id);

		await new Promise((resolve, reject) => {
			const ws = new WebSocket(session.ws_url);
			// Gemini sends its JSON as binary frames as often as text ones.
			ws.binaryType = "arraybuffer";
			this.ws = ws;
			this.setupDone = false;
			ws.onopen = () => ws.send(JSON.stringify(session.setup));
			ws.onmessage = (event) => {
				const raw =
					typeof event.data === "string"
						? event.data
						: decoder.decode(event.data);
				let msg;
				try {
					msg = JSON.parse(raw);
				} catch {
					return;
				}
				if (msg.setupComplete) {
					this.setupDone = true;
					patch({ status: "listening" });
					resolve();
					return;
				}
				this.onServerMessage(msg);
			};
			ws.onerror = () => reject(new Error("voice connection failed"));
			ws.onclose = (e) => {
				if (this.ws !== ws) return; // replaced by a reconnect, or stopped
				this.ws = null;
				if (!this.setupDone) {
					reject(new Error(e.reason || `voice connection closed (${e.code})`));
				} else if (this.active) {
					this.fail(e.reason || `connection closed (${e.code})`, {
						code: e.code,
					});
				}
			};
		});
	}

	closeSocket() {
		const ws = this.ws;
		this.ws = null;
		this.setupDone = false;
		if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
	}

	// The provider is about to drop this connection: open a fresh one that
	// resumes the same session, then retire the old socket.
	async reconnect() {
		const old = this.ws;
		this.ws = null;
		try {
			await this.connect();
		} catch (err) {
			this.fail(describeError(err));
		} finally {
			if (old && old.readyState <= WebSocket.OPEN) old.close();
		}
	}

	onServerMessage(msg) {
		if (msg.usageMetadata) {
			// One report per generation (a tool exchange has two), each re-billing
			// the whole context. Audio bills apart from text; whatever isn't
			// listed as audio (tool declarations included) is text, and thinking
			// bills as text output.
			const u = msg.usageMetadata;
			this.turn.tokensIn += u.promptTokenCount || 0;
			this.turn.tokensInAudio += modalityTokens(u.promptTokensDetails, "AUDIO");
			this.turn.tokensOut +=
				(u.responseTokenCount || 0) + (u.thoughtsTokenCount || 0);
			this.turn.tokensOutAudio += modalityTokens(
				u.responseTokensDetails,
				"AUDIO",
			);
		}
		if (msg.voiceActivity?.type === "ACTIVITY_END") {
			this.speechEndedAt = performance.now();
		}
		if (msg.sessionResumptionUpdate) {
			const u = msg.sessionResumptionUpdate;
			if (u.resumable && u.newHandle) this.resumeHandle = u.newHandle;
		}
		if (msg.goAway) {
			this.reconnect();
		}
		if (msg.toolCall) {
			for (const call of msg.toolCall.functionCalls || []) this.runTool(call);
		}
		if (msg.toolCallCancellation) {
			const ids = new Set(msg.toolCallCancellation.ids || []);
			patch({
				tools: store().tools.map((t) =>
					ids.has(t.id) ? { ...t, done: true, ok: false } : t,
				),
			});
		}
		const sc = msg.serverContent;
		if (!sc) return;

		if (sc.inputTranscription?.text) {
			// You started a new exchange: clear the previous one off the screen.
			if (this.turnFinished) {
				this.turnFinished = false;
				store().resetTurn();
			}
			this.turn.user += sc.inputTranscription.text;
			patch({ userText: this.turn.user });
		}
		if (sc.outputTranscription?.text) {
			// The answer after a tool is a new utterance: keep it apart from the
			// "let me check" that came before.
			if (
				!this.spokeSinceTool &&
				this.turn.piuma &&
				!/\s$/.test(this.turn.piuma)
			)
				this.turn.piuma += " ";
			this.spokeSinceTool = true;
			this.turn.piuma += sc.outputTranscription.text;
			patch({ piumaText: this.turn.piuma });
		}
		for (const part of sc.modelTurn?.parts || []) {
			const audio = part.inlineData;
			if (audio?.data && audio.mimeType?.startsWith("audio/pcm")) {
				this.player?.port.postMessage(base64ToFloat32(audio.data));
				if (this.speechEndedAt !== null) {
					if (this.turn.latencyMs === null)
						this.turn.latencyMs = Math.round(
							performance.now() - this.speechEndedAt,
						);
					this.speechEndedAt = null;
				}
				if (store().status !== "speaking") patch({ status: "speaking" });
			}
		}
		if (sc.interrupted) {
			// Barge-in: you talked over Piuma — stop speaking right away.
			this.player?.port.postMessage({ type: "clear" });
			this.turn.interrupted = true;
			patch({ status: "listening", outLevel: 0 });
		}
		if (
			sc.turnComplete &&
			this.toolsInFlight === 0 &&
			(this.spokeSinceTool || this.turn.interrupted)
		) {
			this.saveTurn();
			this.turnFinished = true;
		}
	}

	async runTool(call) {
		const { id, name, args } = call;
		this.toolsInFlight++;
		this.spokeSinceTool = false;
		patch({
			status: "thinking",
			tools: [
				...store().tools,
				{ id, name, label: null, done: false, ok: false },
			],
		});
		let response;
		try {
			const r = await this.deps.runTool({
				conversation_id: store().conversationId,
				name,
				args: args || {},
			});
			response = r.result;
			this.turn.tools.push({ name, input: args || {}, output: r.result });
			patch({
				tools: store().tools.map((t) =>
					t.id === id ? { ...t, done: true, ok: r.ok, label: r.label } : t,
				),
			});
			if (r.ok && r.result?.navigate) this.deps.navigate(r.result.navigate);
		} catch (err) {
			report("tool_relay_failed", describeError(err), { tool: name }, "warn");
			response = { error: describeError(err) };
			patch({
				tools: store().tools.map((t) =>
					t.id === id ? { ...t, done: true, ok: false } : t,
				),
			});
		}
		this.toolsInFlight--;
		this.send({
			toolResponse: { functionResponses: [{ id, name, response }] },
		});
	}

	// Persist the finished exchange (your words, then Piuma's) in order, and
	// have the chat dock re-read the conversation.
	saveTurn() {
		const {
			user,
			piuma,
			tools,
			interrupted,
			tokensIn,
			tokensOut,
			tokensInAudio,
			tokensOutAudio,
			latencyMs,
		} = this.turn;
		this.turn = newTurn();
		this.spokeSinceTool = true;
		const conversationId = store().conversationId;
		if (!conversationId || !this.deps) return;
		if (!user.trim() && !piuma.trim() && !tools.length) return;
		const { saveTurn, focusConversation } = this.deps;
		this.saveChain = this.saveChain
			.then(async () => {
				if (user.trim())
					await saveTurn({
						conversation_id: conversationId,
						role: "user",
						text: user,
					});
				if (piuma.trim() || tools.length)
					await saveTurn({
						conversation_id: conversationId,
						role: "assistant",
						text: piuma,
						tools,
						interrupted,
						tokens_input: tokensIn,
						tokens_output: tokensOut,
						tokens_input_audio: tokensInAudio,
						tokens_output_audio: tokensOutAudio,
						latency_ms: latencyMs,
					});
				focusConversation(conversationId);
			})
			.catch((err) =>
				report("turn_save_failed", describeError(err), {}, "warn"),
			);
	}
}

const voiceEngine = new VoiceEngine();
export default voiceEngine;
