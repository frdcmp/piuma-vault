import { useCallback, useEffect, useRef, useState } from "react";
import { recorderWsUrl } from "../api/recorderApi";
import { toast } from "../components/Toast";
import { useCreateRecording } from "../queries/recorderQuery";
import { useNativeAudioStream } from "./audioStream";
import { barsFromPcm16, base64ToBytes, rmsFromPcm16 } from "./pcm";

// Bar count for the mirrored "specular" waveform (matches Waveform's render).
const WAVE_BARS = 28;

// The native recorder brain. Mirrors the web RecorderPage:
//   create session → mic PCM16 stream → WebSocket relay → live transcript
//   → stop → session sits at 'ready' awaiting the post-stop choice.
// Capture keeps running with the screen off (see audioStream.js).

// Live transcript terminal tuning — identical to the web client so the feed
// reads the same: buffer words into lines, scroll the last few.
const MAX_WORDS_PER_LINE = 8;
// Enough to fill the tall transcript feed (it now stretches from under the
// waveform to the bottom of the screen); older lines clip as they scroll up.
const MAX_LINES = 16;
const tidyLine = (s) =>
	s
		.replace(/\s+([,.!?;:])/g, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();
const endsSentence = (s) => /[.!?]$/.test(s.trim());

export function useRecorderStream() {
	const createRecording = useCreateRecording();
	const audio = useNativeAudioStream();
	// Latest audio wrapper, read by stable callbacks so they don't churn on
	// every render (audio is a fresh object each render).
	const audioRef = useRef(audio);
	audioRef.current = audio;

	// idle | connecting | recording | finishing
	const [phase, setPhase] = useState("idle");
	const [lines, setLines] = useState([]); // [{ id, text, speaker }]
	// After stop, the session id awaiting the user's choice (summarise/append/
	// keep). Null when there's nothing pending.
	const [postStop, setPostStop] = useState(null);
	// True while the idle visualizer monitor is tapping the mic (no WS/session) —
	// just to drive the waveform/black hole before recording, like the web app.
	const [monitoring, setMonitoring] = useState(false);
	const monitoringRef = useRef(false);

	// Live resources kept out of render state.
	const wsRef = useRef(null);
	const sessionIdRef = useRef(null);
	// Watchdog: if the backend never sends 'stopped'/'error' after we ask to
	// stop, we'd hang on "finishing" forever. This timer forces a graceful exit.
	const finishTimerRef = useRef(null);
	// Shared with the visuals: each PCM chunk writes its RMS here (the black hole
	// polls it) and its per-bar peaks here (the mirrored waveform polls them) —
	// like the web AnalyserNode driving both.
	const levelRef = useRef(0);
	const barsRef = useRef(new Array(WAVE_BARS).fill(0));

	// Transcript buffers.
	const committedRef = useRef([]); // [{ id, text, speaker }]
	const lineBufRef = useRef("");
	const lineIdRef = useRef(0);
	const speakerRef = useRef(null);

	// Mirror phase into a ref for the WS/audio callbacks (they close over the
	// initial render).
	const phaseRef = useRef(phase);
	phaseRef.current = phase;

	const resetBuffers = useCallback(() => {
		committedRef.current = [];
		lineBufRef.current = "";
		speakerRef.current = null;
		setLines([]);
	}, []);

	const teardown = useCallback(async () => {
		await audio.stop();
		try {
			wsRef.current?.close();
		} catch {}
		wsRef.current = null;
		levelRef.current = 0;
	}, [audio]);

	// `teardown` (and `audio`) get a fresh identity every render. Keep the latest
	// in a ref so the unmount-only cleanup below never lists it as a dependency —
	// otherwise that "cleanup" runs on every re-render and stops the recording
	// one chunk in (the bug behind the flat waveform + stuck "finishing").
	const teardownRef = useRef(teardown);
	teardownRef.current = teardown;

	// ── Idle visualizer monitor ─────────────────────────────────────────────
	// Tap the mic (no WebSocket, no session, no notification) just to feed the
	// waveform/black hole while idle. Only runs if mic permission is already
	// granted — it must never prompt on screen entry. Stable identities (use
	// refs) so the controlling effect doesn't re-fire on every render.
	const startMonitor = useCallback(async () => {
		if (monitoringRef.current || phaseRef.current !== "idle") return;
		const ok = await audioRef.current.checkPermission();
		if (!ok || monitoringRef.current || phaseRef.current !== "idle") return;
		monitoringRef.current = true;
		setMonitoring(true);
		try {
			await audioRef.current.start({
				sampleRate: 16000,
				background: false,
				onChunk: (b64) => {
					if (!monitoringRef.current) return;
					const bytes = base64ToBytes(b64);
					levelRef.current = rmsFromPcm16(bytes);
					barsRef.current = barsFromPcm16(bytes, WAVE_BARS);
				},
			});
		} catch {
			monitoringRef.current = false;
			setMonitoring(false);
		}
	}, []);

	const stopMonitor = useCallback(async () => {
		if (!monitoringRef.current) return;
		monitoringRef.current = false;
		setMonitoring(false);
		levelRef.current = 0;
		barsRef.current = new Array(WAVE_BARS).fill(0);
		await audioRef.current.stop();
	}, []);

	// Push a final word into the rolling terminal feed (web parity).
	const pushWord = useCallback((word, speaker) => {
		if (!word) return;
		// Speaker changed mid-line → commit the current line first.
		if (speaker !== speakerRef.current && lineBufRef.current) {
			committedRef.current.push({
				id: ++lineIdRef.current,
				text: tidyLine(lineBufRef.current),
				speaker: speakerRef.current,
			});
			if (committedRef.current.length > MAX_LINES) committedRef.current.shift();
			lineBufRef.current = "";
		}
		speakerRef.current = speaker;

		lineBufRef.current = lineBufRef.current
			? `${lineBufRef.current} ${word}`
			: word;
		const count = lineBufRef.current.split(/\s+/).length;
		if (endsSentence(word) || count >= MAX_WORDS_PER_LINE) {
			committedRef.current.push({
				id: ++lineIdRef.current,
				text: tidyLine(lineBufRef.current),
				speaker,
			});
			if (committedRef.current.length > MAX_LINES) committedRef.current.shift();
			lineBufRef.current = "";
		}
		const display = [...committedRef.current];
		if (lineBufRef.current) {
			display.push({ id: "buf", text: tidyLine(lineBufRef.current), speaker });
		}
		setLines(display.slice(-MAX_LINES));
	}, []);

	const clearFinishTimer = useCallback(() => {
		if (finishTimerRef.current) {
			clearTimeout(finishTimerRef.current);
			finishTimerRef.current = null;
		}
	}, []);

	const handleStopped = useCallback(
		(sessionId) => {
			console.log("[rec] stopped ← session", sessionId);
			clearFinishTimer();
			teardown();
			setPhase("idle");
			if (sessionId) setPostStop(sessionId);
		},
		[teardown, clearFinishTimer],
	);

	const handleError = useCallback(
		(message) => {
			console.log("[rec] error ←", message);
			clearFinishTimer();
			teardown();
			setPhase("idle");
			toast.error(message || "Recording failed");
		},
		[teardown, clearFinishTimer],
	);

	// Open the socket and wire the mic for an already-created session.
	const beginCapture = useCallback(
		async ({ ws_path, sample_rate }) => {
			const granted = await audio.requestPermission();
			if (!granted) {
				toast.error("Microphone access is needed to record");
				setPhase("idle");
				return;
			}

			const url = recorderWsUrl(ws_path);
			console.log("[rec] opening WS", url.replace(/token=[^&]+/, "token=***"));
			const ws = new WebSocket(url);
			ws.binaryType = "arraybuffer";
			wsRef.current = ws;
			resetBuffers();

			let sent = 0;
			ws.onopen = async () => {
				console.log("[rec] WS open → starting mic");
				try {
					await audio.start({
						sampleRate: sample_rate || 16000,
						onChunk: (b64) => {
							const sock = wsRef.current;
							if (!sock || sock.readyState !== WebSocket.OPEN) return;
							try {
								const bytes = base64ToBytes(b64);
								levelRef.current = rmsFromPcm16(bytes);
								barsRef.current = barsFromPcm16(bytes, WAVE_BARS);
								// RN WebSocket sends a typed array as a binary frame.
								sock.send(bytes);
								sent++;
								if (sent === 1 || sent % 25 === 0) {
									console.log(
										`[rec] sent frame #${sent} (${bytes.length}B, lvl ${levelRef.current.toFixed(2)})`,
									);
								}
							} catch (e) {
								console.log("[rec] send failed:", String(e));
							}
						},
					});
					setPhase("recording");
				} catch (e) {
					console.log("[rec] mic start failed:", String(e));
					handleError("Couldn't start the microphone");
				}
			};

			ws.onmessage = (event) => {
				let msg;
				try {
					msg = JSON.parse(event.data);
				} catch {
					return;
				}
				if (msg.type === "transcript" && msg.segment?.is_final) {
					pushWord(
						(msg.segment.text || "").trim(),
						msg.segment.speaker ?? null,
					);
				} else if (msg.type === "transcript") {
					// partial — ignore for the durable feed
				} else {
					console.log("[rec] WS msg:", msg.type);
					if (msg.type === "stopped") {
						handleStopped(msg.session_id || sessionIdRef.current);
					} else if (msg.type === "error") {
						handleError(msg.message);
					}
				}
			};

			ws.onerror = (e) => {
				console.log("[rec] WS error:", e?.message || "(no message)");
				if (phaseRef.current !== "finishing") toast.error("Connection error");
			};
			ws.onclose = (e) => {
				console.log(`[rec] WS close code=${e?.code} reason=${e?.reason || ""}`);
				// If the socket drops without a 'stopped' frame, fall back to idle.
				if (phaseRef.current === "recording") {
					teardown();
					setPhase("idle");
				}
			};
		},
		[audio, resetBuffers, pushWord, handleStopped, handleError, teardown],
	);

	// New recording: free the mic from the idle monitor, create the row, capture.
	const start = useCallback(async () => {
		if (phaseRef.current !== "idle") return;
		await stopMonitor(); // hand the mic over from the visualizer monitor
		setPhase("connecting");
		let session;
		try {
			session = await createRecording.mutateAsync({ title: "" });
		} catch {
			toast.error("Could not create recording session");
			setPhase("idle");
			return;
		}
		sessionIdRef.current = session.session_id;
		await beginCapture(session);
	}, [createRecording, beginCapture, stopMonitor]);

	const stop = useCallback(() => {
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "stop" }));
		}
		// Stop sending audio immediately; await the 'stopped' frame, then the
		// post-stop choice opens.
		audio.stop();
		levelRef.current = 0;
		setPhase("finishing");
		// Watchdog: don't hang on "finishing" if the backend never replies. On
		// socket close the backend flushes the transcript to 'ready' anyway, so
		// after the grace period we proceed to the post-stop choice regardless.
		clearFinishTimer();
		finishTimerRef.current = setTimeout(() => {
			console.log("[rec] finishing watchdog fired — forcing post-stop");
			teardown();
			setPhase("idle");
			if (sessionIdRef.current) setPostStop(sessionIdRef.current);
		}, 9000);
	}, [audio, clearFinishTimer, teardown]);

	const clearPostStop = useCallback(() => setPostStop(null), []);

	// Run the idle visualizer monitor whenever we're idle and not mid-decision;
	// drop it otherwise. startMonitor/stopMonitor are stable, so this only fires
	// on real phase/postStop changes.
	useEffect(() => {
		if (phase === "idle" && !postStop) startMonitor();
		else stopMonitor();
	}, [phase, postStop, startMonitor, stopMonitor]);

	// Clean up ONLY when the screen actually unmounts. Empty deps + the ref keep
	// this from firing on every re-render (which would stop recording instantly).
	// biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only by design
	useEffect(
		() => () => {
			clearFinishTimer();
			teardownRef.current?.();
		},
		[],
	);

	return {
		phase,
		lines,
		levelRef,
		barsRef,
		monitoring,
		start,
		stop,
		postStop,
		clearPostStop,
	};
}
