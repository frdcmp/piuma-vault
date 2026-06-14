import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRecorderStream } from "../audio/useRecorderStream";
import PixelStarfield from "../components/PixelStarfield";
import BlackHole from "../components/recorder/BlackHole";
import PostStopModal from "../components/recorder/PostStopModal";
import Waveform from "../components/recorder/Waveform";
import ScreenHeader from "../components/ScreenHeader";
import { toast } from "../components/Toast";
import {
	useAppendRecording,
	useRecordings,
	useSummariseRecording,
} from "../queries/recorderQuery";
import { colors, mono } from "../utils/theme";

// Fully native recorder scene: a starfield, the black-hole record button, a
// live waveform, and the scrolling transcript. Audio is captured natively
// (PCM16 → WebSocket relay) and keeps running with the screen off — see
// useRecorderStream / audioStream. No WebView.

const PHASE_LABEL = {
	idle: "HOLD THE VOID · 3S TO IGNITE",
	connecting: "OPENING THE VOID…",
	recording: "● REC — HOLD 3S TO STOP",
	finishing: "FINISHING…",
};
const PHASE_TAG = {
	idle: "READY",
	connecting: "OPENING…",
	recording: "● REC",
	finishing: "FINISHING…",
};
const PHASE_COLOR = {
	idle: colors.muted,
	connecting: colors.accent4,
	recording: colors.accent3,
	finishing: colors.accent,
};

export default function RecorderScreen({ navigation }) {
	const {
		phase,
		lines,
		levelRef,
		barsRef,
		monitoring,
		start,
		stop,
		postStop,
		clearPostStop,
	} = useRecorderStream();
	const { data: recordings = [] } = useRecordings();
	const summarise = useSummariseRecording();
	const append = useAppendRecording();

	// null while idle; a status label string while a summarise/append runs.
	const [busy, setBusy] = useState(null);
	const [scene, setScene] = useState({ w: 0, h: 0 });
	// null | "start" | "stop" — which hold the user is performing on the void.
	const [chargeMode, setChargeMode] = useState(null);

	// Decision made → close the modal and open the session's detail page.
	const finishTo = useCallback(
		(sessionId) => {
			setBusy(null);
			clearPostStop();
			if (sessionId) navigation.navigate("RecordingDetail", { id: sessionId });
			else navigation.navigate("RecorderSessions");
		},
		[clearPostStop, navigation],
	);

	const doSummarise = useCallback(async () => {
		if (!postStop) return;
		setBusy("Collapsing transcript into a summary…");
		try {
			const res = await summarise.mutateAsync(postStop);
			finishTo(res?.session_id || postStop);
		} catch {
			toast.error("Couldn't summarise the recording");
			setBusy(null);
		}
	}, [postStop, summarise, finishTo]);

	const doKeep = useCallback(() => {
		const id = postStop;
		toast.success("Transcript saved");
		finishTo(id);
	}, [postStop, finishTo]);

	const doAppend = useCallback(
		async (targetId) => {
			if (!postStop || !targetId) return;
			setBusy("Merging transcripts & re-summarizing…");
			try {
				const res = await append.mutateAsync({ id: postStop, targetId });
				toast.success("Appended & re-summarised");
				finishTo(res?.session_id || targetId);
			} catch {
				toast.error("Couldn't append to that recording");
				setBusy(null);
			}
		},
		[postStop, append, finishTo],
	);

	// Candidate targets: any other recording with a saved transcript.
	const appendTargets = recordings.filter(
		(r) =>
			r.id !== postStop &&
			(r.status === "ready" || r.status === "done") &&
			r.transcript_storage_key,
	);

	// Fixed black hole + fixed transcript box, both sized from the (stable) scene
	// dimensions only — never from content — so the centered group's height is
	// constant and the hole never moves, in any phase.
	const holeSize = scene.w
		? Math.max(120, Math.min(scene.w * 0.55, scene.h * 0.3, 240))
		: 180;

	return (
		<View style={styles.root}>
			<ScreenHeader
				title="Recorder"
				icon="mic-outline"
				subtitle={PHASE_TAG[phase] || "READY"}
				subtitleColor={PHASE_COLOR[phase]}
				onBack={() => navigation.goBack()}
				style={styles.headerLift}
				right={
					<Pressable
						onPress={() => navigation.navigate("RecorderSessions")}
						hitSlop={10}
						style={styles.sessionsBtn}
					>
						<Ionicons name="albums-outline" size={16} color={colors.accent4} />
						<Text style={styles.sessionsText}>sessions</Text>
					</Pressable>
				}
			/>

			<View
				style={styles.scene}
				onLayout={(e) =>
					setScene({
						w: e.nativeEvent.layout.width,
						h: e.nativeEvent.layout.height,
					})
				}
			>
				{scene.w > 0 && <PixelStarfield width={scene.w} height={scene.h} />}

				{/* Fixed layout: the hole + label + waveform are centered in the top
				    region (which is always the scene minus the reserved transcript
				    box), so the black hole sits in the same centered spot in every
				    phase. The transcript clips inside its fixed bottom box. */}
				<View style={styles.sceneInner}>
					{/* Flex spacer above the hole + a flexed transcript below set the
					    vertical balance: the hole sits a bit below the top, the feed
					    fills the rest down to the bottom edge. */}
					<View style={styles.spacerTop} />
					<View style={styles.stage}>
						<BlackHole
							state={phase}
							levelRef={levelRef}
							size={holeSize}
							onStart={start}
							onStop={stop}
							onChargingChange={setChargeMode}
						/>

						<Text
							style={[
								styles.holeLabel,
								{
									color:
										chargeMode === "stop"
											? colors.accent3
											: chargeMode === "start"
												? colors.accent
												: PHASE_COLOR[phase],
								},
							]}
						>
							{chargeMode === "start"
								? "POWERING UP…"
								: chargeMode === "stop"
									? "COLLAPSING…"
									: PHASE_LABEL[phase]}
						</Text>

						<Waveform
							barsRef={barsRef}
							active={phase === "recording" || monitoring}
						/>
					</View>

					<View style={styles.term}>
						{phase !== "idle" &&
							lines.map((ln, i) => {
								const latest = i === lines.length - 1;
								return (
									<Text
										key={ln.id}
										style={[styles.termLine, latest && styles.termLatest]}
										numberOfLines={1}
									>
										<Text style={styles.termCaret}>›</Text> {ln.text}
										{latest ? " ▋" : ""}
									</Text>
								);
							})}
					</View>
				</View>
			</View>

			<PostStopModal
				visible={!!postStop}
				busy={busy}
				appendTargets={appendTargets}
				onSummarise={doSummarise}
				onAppend={doAppend}
				onKeep={doKeep}
				onClose={() => {
					// Closing without a choice keeps it as a transcript-only recording.
					doKeep();
				}}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#0b0c10" },
	// Keep the shared header above the starfield scene that renders below it.
	headerLift: { zIndex: 2 },
	sessionsBtn: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		borderWidth: 2,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		paddingHorizontal: 10,
		paddingVertical: 6,
	},
	sessionsText: {
		fontFamily: mono,
		color: colors.accent4,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1,
		textTransform: "uppercase",
	},
	scene: { flex: 1, backgroundColor: "#0b0c10", overflow: "hidden" },
	sceneInner: { flex: 1, paddingHorizontal: 16, paddingVertical: 16 },
	// Spacer above the hole — its flex vs the transcript's flex sets how far down
	// the hole sits (smaller flex here = higher hole).
	spacerTop: { flex: 1 },
	// Hole + label + waveform group. Content-sized (no flex) so its height is
	// constant → the hole sits in the same spot every phase.
	stage: {
		alignItems: "center",
		gap: 14,
	},
	holeLabel: {
		fontFamily: mono,
		fontSize: 12,
		fontWeight: "700",
		letterSpacing: 1,
		textAlign: "center",
	},
	term: {
		// Starts right under the waveform and flexes down to the bottom edge.
		// A bigger flex than spacerTop pulls the hole upward into the top third
		// while the feed owns the lower ~60%. Newest line pinned to the bottom;
		// older lines scroll up and clip.
		flex: 1.7,
		minHeight: 0,
		width: "100%",
		maxWidth: 460,
		alignSelf: "center",
		justifyContent: "flex-end",
		overflow: "hidden",
		gap: 2,
		paddingTop: 8,
		paddingBottom: 4,
	},
	termLine: {
		fontFamily: mono,
		fontSize: 12,
		lineHeight: 18,
		color: colors.muted,
		opacity: 0.6,
	},
	termLatest: { color: colors.text, opacity: 1 },
	termCaret: { color: colors.accent2 },
});
