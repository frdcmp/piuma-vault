import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { recorderWsUrl } from "../../../api/recorder";
import {
	useAppendRecording,
	useCreateRecording,
	useRecordings,
	useSummariseRecording,
} from "../../../queries";
import Starfield from "../../components/notes/Starfield";
import { PvButton, PvModal, pvMessage } from "../../components/ui";
import "../../vault-pixel.css";
import BlackHole from "./BlackHole";
import PixelWaveform from "./PixelWaveform";
import { colorForSpeaker, resetSpeakerColors } from "./speakerColors";
import "./recorder.css";

// The recorder is a scene, not a form: a starfield, a big pixel black hole that
// IS the record button, a live pixel waveform with the vault mascot, and a link
// down to the sessions archive. All capture plumbing (mic → AudioWorklet PCM16
// → WebSocket relay) is unchanged from the previous form-based page.

// When hosted inside the mobile app's WebView, the native shell owns navigation
// and the sessions archive. Detect the bridge and post lifecycle events to it
// (instead of navigating the SPA to the note / sessions list).
const isEmbedded = typeof window !== "undefined" && !!window.ReactNativeWebView;
const postNative = (payload) => {
	try {
		window.ReactNativeWebView?.postMessage(JSON.stringify(payload));
	} catch {}
};

// Live transcript terminal: providers emit word-by-word, so we buffer words
// into lines and scroll the last few like a terminal feed.
const MAX_WORDS_PER_LINE = 8;
const MAX_LINES = 9;
const tidyLine = (s) =>
	s
		.replace(/\s+([,.!?;:])/g, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();
const endsSentence = (s) => /[.!?]$/.test(s.trim());

export default function RecorderPage() {
	const navigate = useNavigate();
	const createRecording = useCreateRecording();
	const summariseRecording = useSummariseRecording();
	const appendRecording = useAppendRecording();
	const { data: recordings = [] } = useRecordings();

	const [searchParams, setSearchParams] = useSearchParams();
	// idle | connecting | recording | finishing
	const [phase, setPhase] = useState("idle");
	const [lines, setLines] = useState([]); // [{ id, text }] terminal feed
	// A session id the agent created (via `?session=`); the black hole arms to it
	// so one tap starts capturing into that existing session.
	const [armed, setArmed] = useState(null);
	// After a stop, the session id awaiting the user's choice (summarise / append
	// / keep). Drives the post-stop modal. `appendPick` toggles the target list.
	const [postStop, setPostStop] = useState(null);
	const [appendPick, setAppendPick] = useState(false);
	// null while idle; a status label string while a summarise/append is running
	// (drives the modal's loader overlay).
	const [busy, setBusy] = useState(null);

	// Live capture resources, kept out of render state.
	const wsRef = useRef(null);
	const ctxRef = useRef(null);
	const streamRef = useRef(null);
	const nodeRef = useRef(null);
	// Transcript terminal buffers: committed lines + the in-progress line.
	const committedRef = useRef([]); // [{ id, text, speaker }]
	const lineBufRef = useRef("");
	const lineIdRef = useRef(0);
	const currentSpeakerRef = useRef(null); // speaker for the in-progress buf
	// Shared with the visuals: the analyser feeds the waveform; the waveform
	// loop writes the RMS level here for the black hole to react to.
	const analyserRef = useRef(null);
	const levelRef = useRef(0);
	// Idle mic monitor: a lightweight, separate mic→analyser graph that runs
	// whenever we're NOT recording, so the waveform shows live input as instant
	// proof the mic works. Torn down the moment real capture takes over.
	const monitorStreamRef = useRef(null);
	const monitorCtxRef = useRef(null);

	// Mirror `phase` into a ref so WS callbacks (which close over the initial
	// render) read the live value instead of a stale one.
	const phaseRef = useRef(phase);
	useEffect(() => {
		phaseRef.current = phase;
		// Let the native shell mirror the capture state in its own header.
		if (isEmbedded) postNative({ type: "phase", phase });
	}, [phase]);

	const teardownAudio = useCallback(() => {
		try {
			nodeRef.current?.disconnect();
		} catch {}
		try {
			for (const t of streamRef.current?.getTracks() ?? []) t.stop();
		} catch {}
		try {
			ctxRef.current?.close();
		} catch {}
		nodeRef.current = null;
		streamRef.current = null;
		ctxRef.current = null;
		analyserRef.current = null;
		levelRef.current = 0;
	}, []);

	// Tear down the idle monitor (its own stream + context, kept separate from
	// the capture graph so stopping one never touches the other).
	const stopMonitor = useCallback(() => {
		try {
			for (const t of monitorStreamRef.current?.getTracks() ?? []) t.stop();
		} catch {}
		try {
			monitorCtxRef.current?.close();
		} catch {}
		monitorStreamRef.current = null;
		monitorCtxRef.current = null;
		if (phaseRef.current !== "recording") {
			analyserRef.current = null;
			levelRef.current = 0;
		}
	}, []);

	// Open the mic just to visualise it while idle — no WebSocket, no worklet.
	// Best-effort: if permission is denied the waveform simply stays flat.
	const startMonitor = useCallback(async () => {
		if (monitorCtxRef.current || phaseRef.current !== "idle") return;
		let stream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			return;
		}
		// Real recording may have begun while we awaited the permission prompt.
		if (phaseRef.current !== "idle") {
			for (const t of stream.getTracks()) t.stop();
			return;
		}
		monitorStreamRef.current = stream;
		const ctx = new AudioContext();
		monitorCtxRef.current = ctx;
		if (ctx.state === "suspended") {
			try {
				await ctx.resume();
			} catch {}
		}
		const source = ctx.createMediaStreamSource(stream);
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 1024;
		analyser.smoothingTimeConstant = 0.5;
		source.connect(analyser);
		analyserRef.current = analyser;
	}, []);

	// Run the monitor whenever idle; drop it the instant we leave idle.
	useEffect(() => {
		if (phase === "idle") startMonitor();
		else stopMonitor();
	}, [phase, startMonitor, stopMonitor]);

	// Clean up if the component unmounts mid-recording.
	useEffect(
		() => () => {
			teardownAudio();
			stopMonitor();
		},
		[teardownAudio, stopMonitor],
	);

	// Agent deep-link `?session=<id>` → arm the hole to that session, then
	// strip the param so a refresh doesn't re-arm.
	const armConsumed = useRef(false);
	useEffect(() => {
		const s = searchParams.get("session");
		if (s && !armConsumed.current) {
			armConsumed.current = true;
			setArmed(s);
			searchParams.delete("session");
			setSearchParams(searchParams, { replace: true });
		}
	}, [searchParams, setSearchParams]);

	const cleanupAfterStop = useCallback(() => {
		teardownAudio();
		setPhase("idle");
	}, [teardownAudio]);

	// Open the mic, wire AudioWorklet → WebSocket for an already-created session.
	// `session` must carry { ws_path, sample_rate }.
	const beginCapture = useCallback(
		async (session) => {
			// Hand the mic over from the idle monitor to the capture graph.
			stopMonitor();
			let stream;
			try {
				stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			} catch {
				pvMessage.error("Microphone permission denied");
				setPhase("idle");
				return;
			}
			streamRef.current = stream;
			committedRef.current = [];
			lineBufRef.current = "";
			currentSpeakerRef.current = null;
			resetSpeakerColors();
			setLines([]);

			const ctx = new AudioContext();
			ctxRef.current = ctx;
			try {
				await ctx.audioWorklet.addModule(
					`${import.meta.env.BASE_URL}recorder-worklet.js`,
				);
				// Browsers start the context suspended until a user gesture; this
				// runs from the black-hole click, so resume is allowed.
				if (ctx.state === "suspended") await ctx.resume();
			} catch {
				pvMessage.error("Failed to load audio processor");
				teardownAudio();
				setPhase("idle");
				return;
			}

			const ws = new WebSocket(recorderWsUrl(session.ws_path));
			ws.binaryType = "arraybuffer";
			wsRef.current = ws;

			const source = ctx.createMediaStreamSource(stream);
			// Tap the raw mic for the pixel waveform + black-hole reactivity.
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 1024;
			analyser.smoothingTimeConstant = 0.5;
			source.connect(analyser);
			analyserRef.current = analyser;

			const node = new AudioWorkletNode(ctx, "pcm16-downsampler", {
				processorOptions: { targetRate: session.sample_rate || 16000 },
			});
			nodeRef.current = node;
			node.port.onmessage = (e) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
			};
			source.connect(node);
			// Keep the graph alive without audible output.
			node.connect(ctx.destination);

			ws.onopen = () => setPhase("recording");
			ws.onmessage = (event) => {
				let msg;
				try {
					msg = JSON.parse(event.data);
				} catch {
					return;
				}
				if (msg.type === "transcript" && msg.segment) {
					if (msg.segment.is_final) {
						const word = (msg.segment.text || "").trim();
						const speaker = msg.segment.speaker ?? null;
						if (word) {
							// Speaker changed mid-line → commit current line first.
							if (speaker !== currentSpeakerRef.current && lineBufRef.current) {
								committedRef.current.push({
									id: ++lineIdRef.current,
									text: tidyLine(lineBufRef.current),
									speaker: currentSpeakerRef.current,
								});
								if (committedRef.current.length > MAX_LINES) {
									committedRef.current.shift();
								}
								lineBufRef.current = "";
							}
							currentSpeakerRef.current = speaker;

							lineBufRef.current = lineBufRef.current
								? `${lineBufRef.current} ${word}`
								: word;
							const count = lineBufRef.current.split(/\s+/).length;
							// Commit the line on a sentence end or once it's long enough.
							if (endsSentence(word) || count >= MAX_WORDS_PER_LINE) {
								committedRef.current.push({
									id: ++lineIdRef.current,
									text: tidyLine(lineBufRef.current),
									speaker,
								});
								if (committedRef.current.length > MAX_LINES) {
									committedRef.current.shift();
								}
								lineBufRef.current = "";
							}
							const display = [...committedRef.current];
							if (lineBufRef.current) {
								display.push({
									id: "buf",
									text: tidyLine(lineBufRef.current),
									speaker,
								});
							}
							setLines(display.slice(-MAX_LINES));
						}
					}
				} else if (msg.type === "stopped") {
					// Transcript is saved ('ready') but deliberately NOT summarised —
					// open the post-stop choice (summarise / append / keep).
					cleanupAfterStop();
					if (msg.session_id) setPostStop(msg.session_id);
				} else if (msg.type === "error") {
					pvMessage.error(msg.message || "Recording failed");
					cleanupAfterStop();
					if (isEmbedded) {
						postNative({ type: "error", message: msg.message || "" });
					}
				}
			};
			ws.onerror = () => pvMessage.error("Connection error");
			ws.onclose = () => {
				if (phaseRef.current !== "summarising") cleanupAfterStop();
			};
		},
		[teardownAudio, cleanupAfterStop, stopMonitor],
	);

	// New recording: create a session, then capture into it. `connecting` shows
	// the black hole "charging" through the create→mic→worklet→WS-open lag.
	const start = useCallback(async () => {
		setPhase("connecting");
		let session;
		try {
			session = await createRecording.mutateAsync({ title: "" });
		} catch {
			pvMessage.error("Could not create recording session");
			setPhase("idle");
			return;
		}
		await beginCapture(session);
	}, [createRecording, beginCapture]);

	// Agent-initiated recording: the session already exists (from the
	// `start_recording` tool), so capture straight into it.
	const startExisting = useCallback(
		async (sessionId) => {
			setArmed(null);
			setPhase("connecting");
			await beginCapture({ ws_path: `/recorder/sessions/${sessionId}/ws` });
		},
		[beginCapture],
	);

	const stop = useCallback(() => {
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "stop" }));
		}
		// Stop sending audio immediately; await the `stopped`/`error` frame, then
		// the post-stop modal opens.
		teardownAudio();
		setPhase("finishing");
	}, [teardownAudio]);

	// ── Post-stop choices ────────────────────────────────────────────────
	// After finishing, the session sits at 'ready' (transcript saved, no note).
	const closePostStop = useCallback(() => {
		setPostStop(null);
		setAppendPick(false);
		setBusy(null);
	}, []);

	// Decision made: embedded → hand off to the native shell; web → open the
	// session's detail page.
	const finishTo = useCallback(
		(sessionId) => {
			closePostStop();
			if (isEmbedded) postNative({ type: "done", session_id: sessionId });
			else if (sessionId) navigate(`/recorder/sessions/${sessionId}`);
		},
		[closePostStop, navigate],
	);

	const doSummarise = useCallback(async () => {
		if (!postStop) return;
		setBusy("Collapsing transcript into a summary…");
		try {
			const res = await summariseRecording.mutateAsync(postStop);
			finishTo(res?.session_id || postStop);
		} catch {
			pvMessage.error("Couldn't summarise the recording");
			setBusy(null);
		}
	}, [postStop, summariseRecording, finishTo]);

	const doKeep = useCallback(() => {
		// Keep it as a transcript-only recording; summarise / append later.
		const id = postStop;
		pvMessage.success("Transcript saved");
		finishTo(id);
	}, [postStop, finishTo]);

	const doAppend = useCallback(
		async (targetId) => {
			if (!postStop || !targetId) return;
			setBusy("Merging transcripts & re-summarizing…");
			try {
				const res = await appendRecording.mutateAsync({
					id: postStop,
					targetId,
				});
				pvMessage.success("Appended & re-summarised");
				finishTo(res?.session_id || targetId);
			} catch {
				pvMessage.error("Couldn't append to that recording");
				setBusy(null);
			}
		},
		[postStop, appendRecording, finishTo],
	);

	// Candidate targets to append into: any other recording with a saved
	// transcript (ready or already summarised), newest first.
	const appendTargets = recordings.filter(
		(r) =>
			r.id !== postStop &&
			(r.status === "ready" || r.status === "done") &&
			r.transcript_storage_key,
	);

	// One control: the black hole. Idle → start (into the armed session if the
	// agent set one up); recording → stop; summarising → inert.
	const onHolePress = useCallback(() => {
		if (phase === "recording") return stop();
		if (phase !== "idle") return;
		if (armed) return startExisting(armed);
		return start();
	}, [phase, armed, start, startExisting, stop]);

	const label =
		phase === "recording"
			? "● REC — TAP TO STOP"
			: phase === "connecting"
				? "OPENING THE VOID…"
				: phase === "finishing"
					? "FINISHING…"
					: armed
						? "AGENT ARMED — TAP TO RECORD"
						: "TAP THE VOID TO RECORD";

	return (
		<div className="recorder-scene">
			<Starfield />

			<div className="recorder-scene-inner">
				<BlackHole state={phase} levelRef={levelRef} onPress={onHolePress} />
				<div className={`recorder-hole-label recorder-hole-label--${phase}`}>
					{label}
				</div>

				<PixelWaveform
					analyserRef={analyserRef}
					active={phase === "recording"}
					levelRef={levelRef}
				/>

				{phase !== "idle" && lines.length > 0 && (
					<div className="recorder-term">
						{lines.map((ln, i) => {
							const latest = i === lines.length - 1;
							const spColor = colorForSpeaker(ln.speaker);
							return (
								<div
									key={ln.id}
									className={`recorder-term-line${latest ? " is-latest" : ""}`}
								>
									{ln.speaker && (
										<span
											className="recorder-term-speaker"
											style={{ color: spColor }}
										>
											{ln.speaker}
										</span>
									)}
									<span className="recorder-term-caret">›</span> {ln.text}
									{latest && <span className="recorder-term-cursor">▋</span>}
								</div>
							);
						})}
					</div>
				)}
			</div>

			{!isEmbedded && (
				<Link to="/recorder/sessions" className="recorder-sessions-link">
					▸ RECORDED SESSIONS
				</Link>
			)}

			<PvModal
				open={!!postStop}
				title="recording stopped"
				onCancel={busy ? undefined : closePostStop}
				dismissOnOverlay={!busy}
				showClose={!busy}
				className="recorder-poststop"
			>
				{busy ? (
					<div className="recorder-poststop-loading">
						<div className="recorder-loader" aria-hidden="true">
							<span />
							<span />
							<span />
							<span />
							<span />
						</div>
						<p className="recorder-loader-label">
							{busy}
							<span className="recorder-term-cursor">▋</span>
						</p>
					</div>
				) : !appendPick ? (
					<div className="recorder-poststop-body">
						<p className="recorder-poststop-text">
							Transcript saved. What do you want to do?
						</p>
						<div className="recorder-poststop-actions">
							<PvButton variant="primary" block onClick={doSummarise}>
								Summarize now
							</PvButton>
							<PvButton
								block
								disabled={appendTargets.length === 0}
								onClick={() => setAppendPick(true)}
							>
								Append to another recording…
							</PvButton>
							<PvButton variant="ghost" block onClick={doKeep}>
								Keep transcript only
							</PvButton>
						</div>
						<p className="recorder-poststop-hint">
							“Keep” stores the transcript without a summary note — summarize or
							append later from its page.
						</p>
					</div>
				) : (
					<div className="recorder-poststop-body">
						<p className="recorder-poststop-text">
							Append this transcript onto…
						</p>
						<ul className="recorder-poststop-list">
							{appendTargets.map((r) => (
								<li key={r.id}>
									<button
										type="button"
										className="recorder-poststop-target"
										onClick={() => doAppend(r.id)}
									>
										<span className="recorder-poststop-target-title">
											{r.title || "Untitled recording"}
										</span>
										<span className="recorder-poststop-target-meta">
											{r.status === "done" ? "summarized · " : ""}
											{r.word_count > 0 ? `${r.word_count} words` : "—"}
										</span>
									</button>
								</li>
							))}
						</ul>
						<PvButton
							variant="ghost"
							block
							onClick={() => setAppendPick(false)}
						>
							← Back
						</PvButton>
					</div>
				)}
			</PvModal>
		</div>
	);
}
