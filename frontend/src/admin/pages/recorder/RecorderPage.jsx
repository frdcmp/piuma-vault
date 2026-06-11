import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { recorderWsUrl } from "../../../api/recorder";
import { useCreateRecording } from "../../../queries";
import Starfield from "../../components/notes/Starfield";
import { pvMessage } from "../../components/ui";
import "../../vault-pixel.css";
import BlackHole from "./BlackHole";
import PixelWaveform from "./PixelWaveform";
import "./recorder.css";

// The recorder is a scene, not a form: a starfield, a big pixel black hole that
// IS the record button, a live pixel waveform with the vault mascot, and a link
// down to the sessions archive. All capture plumbing (mic → AudioWorklet PCM16
// → WebSocket relay) is unchanged from the previous form-based page.

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

	const [searchParams, setSearchParams] = useSearchParams();
	const [phase, setPhase] = useState("idle"); // idle | recording | summarising
	const [lines, setLines] = useState([]); // [{ id, text }] terminal feed
	// A session id the agent created (via `?session=`); the black hole arms to it
	// so one tap starts capturing into that existing session.
	const [armed, setArmed] = useState(null);

	// Live capture resources, kept out of render state.
	const wsRef = useRef(null);
	const ctxRef = useRef(null);
	const streamRef = useRef(null);
	const nodeRef = useRef(null);
	// Transcript terminal buffers: committed lines + the in-progress line.
	const committedRef = useRef([]); // [{ id, text }]
	const lineBufRef = useRef("");
	const lineIdRef = useRef(0);
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
			let stream;
			try {
				stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			} catch {
				pvMessage.error("Microphone permission denied");
				return;
			}
			streamRef.current = stream;
			committedRef.current = [];
			lineBufRef.current = "";
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
						if (word) {
							lineBufRef.current = lineBufRef.current
								? `${lineBufRef.current} ${word}`
								: word;
							const count = lineBufRef.current.split(/\s+/).length;
							// Commit the line on a sentence end or once it's long enough.
							if (endsSentence(word) || count >= MAX_WORDS_PER_LINE) {
								committedRef.current.push({
									id: ++lineIdRef.current,
									text: tidyLine(lineBufRef.current),
								});
								if (committedRef.current.length > MAX_LINES) {
									committedRef.current.shift();
								}
								lineBufRef.current = "";
							}
							const display = [...committedRef.current];
							if (lineBufRef.current) {
								// Stable id so the in-progress line updates in place.
								display.push({ id: "buf", text: tidyLine(lineBufRef.current) });
							}
							setLines(display.slice(-MAX_LINES));
						}
					}
				} else if (msg.type === "summarising") {
					setPhase("summarising");
				} else if (msg.type === "done") {
					pvMessage.success("Summary saved to your vault");
					cleanupAfterStop();
					if (msg.note_id) navigate(`/notes/${msg.note_id}`);
				} else if (msg.type === "error") {
					pvMessage.error(msg.message || "Recording failed");
					cleanupAfterStop();
				}
			};
			ws.onerror = () => pvMessage.error("Connection error");
			ws.onclose = () => {
				if (phaseRef.current !== "summarising") cleanupAfterStop();
			};
		},
		[navigate, teardownAudio, cleanupAfterStop],
	);

	// New recording: create a session, then capture into it.
	const start = useCallback(async () => {
		let session;
		try {
			session = await createRecording.mutateAsync({ title: "" });
		} catch {
			pvMessage.error("Could not create recording session");
			return;
		}
		await beginCapture(session);
	}, [createRecording, beginCapture]);

	// Agent-initiated recording: the session already exists (from the
	// `start_recording` tool), so capture straight into it.
	const startExisting = useCallback(
		async (sessionId) => {
			setArmed(null);
			await beginCapture({ ws_path: `/recorder/sessions/${sessionId}/ws` });
		},
		[beginCapture],
	);

	const stop = useCallback(() => {
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "stop" }));
		}
		// Stop sending audio immediately; await the `done`/`error` frame.
		teardownAudio();
		setPhase("summarising");
	}, [teardownAudio]);

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
			: phase === "summarising"
				? "SUMMARISING…"
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
						{lines.map((ln, i) => (
							<div
								key={ln.id}
								className="recorder-term-line"
								style={{ "--term-i": lines.length - 1 - i }}
							>
								<span className="recorder-term-caret">›</span> {ln.text}
								{i === lines.length - 1 && (
									<span className="recorder-term-cursor">▋</span>
								)}
							</div>
						))}
					</div>
				)}
			</div>

			<Link to="/recorder/sessions" className="recorder-sessions-link">
				▸ RECORDED SESSIONS
			</Link>
		</div>
	);
}
