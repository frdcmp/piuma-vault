import { ExpoAudioStreamModule, useAudioRecorder } from "@siteed/audio-studio";
import { useCallback } from "react";

// Thin wrapper around @siteed/audio-studio — the one native module that
// gives us real-time PCM from the mic (what expo-audio won't) AND keeps
// capturing in the background. Isolated here so the rest of the app talks to a
// tiny, stable surface and there's a single place to adjust if the library's
// API shifts.
//
// We ask for: raw little-endian PCM16, 16 kHz, mono — the exact format the
// backend relay forwards to Speechmatics. The library emits each chunk as a
// base64 string on `onAudioStream`.

// How often (ms) the native side flushes a PCM chunk up to JS. 100ms keeps the
// waveform fluid (fresh data 10×/s) and the transcript snappy without spamming
// the bridge.
const EMIT_INTERVAL_MS = 100;

export function useNativeAudioStream() {
	const recorder = useAudioRecorder();

	const requestPermission = useCallback(async () => {
		try {
			const res = await ExpoAudioStreamModule.requestPermissionsAsync();
			return !!res?.granted;
		} catch {
			return false;
		}
	}, []);

	// Non-prompting check — used so the idle visualizer monitor only runs when
	// mic access is already granted (it should never nag on screen entry).
	const checkPermission = useCallback(async () => {
		try {
			const res = await ExpoAudioStreamModule.getPermissionsAsync();
			return !!res?.granted;
		} catch {
			return false;
		}
	}, []);

	// Begin capturing. `onChunk(base64)` fires every EMIT_INTERVAL_MS with the
	// next slice of PCM16. Background capture + the ongoing "recording" service
	// notification are enabled here (Android foreground service / iOS audio
	// session), so recording survives the screen turning off — like Otter.
	const start = useCallback(
		async ({ sampleRate = 16000, onChunk, background = true }) => {
			let chunks = 0;
			console.log("[rec] startRecording → sampleRate", sampleRate, "background", background);
			const res = await recorder.startRecording({
				interval: EMIT_INTERVAL_MS,
				sampleRate,
				channels: 1,
				encoding: "pcm_16bit",
				// We only stream to the backend — don't write an audio file at all
				// (avoids file-I/O that can stall capture). "Streaming only" mode.
				output: { primary: { enabled: false } },
				// Deliver base64 PCM bytes to onAudioStream (default, but explicit).
				streamFormat: "raw",
				// Background capture (screen-off survival) is only for the real
				// recording. The idle visualizer monitor runs foreground-only: no
				// wake-lock, no foreground-service notification.
				keepAwake: background,
				showNotification: background,
				showWaveformInNotification: false,
				notification: background
					? {
							title: "Recording",
							text: "pv vault — tap to return",
							android: {
								// Bumped id: Android locks a channel's name/importance at
								// creation, so a new id is needed for the calmer settings.
								channelId: "recorder-v2",
								channelName: "Voice recording",
								channelDescription:
									"Shown while the vault recorder is capturing audio",
								notificationId: 4242,
								priority: "default",
								accentColor: "#5cd0a9",
								// Declutter: the library adds Pause/Resume buttons by
								// default, which we don't use (one tap to stop in-app).
								showPauseResumeActions: false,
							},
						}
					: undefined,
				onAudioStream: async (event) => {
					// On native the chunk is a base64 string; ignore any other shape.
					const data = event?.data;
					if (typeof data === "string" && data.length) {
						chunks++;
						if (chunks === 1 || chunks % 25 === 0) {
							console.log(`[rec] audio chunk #${chunks} (${data.length} b64)`);
						}
						onChunk(data);
					} else if (chunks === 0) {
						console.log("[rec] onAudioStream fired but data is not a string:", typeof data);
					}
				},
			});
			console.log("[rec] startRecording resolved:", JSON.stringify(res)?.slice(0, 200));
		},
		[recorder],
	);

	const stop = useCallback(async () => {
		try {
			await recorder.stopRecording();
		} catch {
			// Already stopped / never started — nothing to do.
		}
	}, [recorder]);

	return {
		requestPermission,
		checkPermission,
		start,
		stop,
		isRecording: recorder.isRecording,
		durationMs: recorder.durationMs,
	};
}
