import { Ionicons } from "@expo/vector-icons";
import {
	ActivityIndicator,
	Dimensions,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import PixelStarfield from "../components/PixelStarfield";
import { toast } from "../components/Toast";
import {
	useRecording,
	useRecordingTranscript,
	useSummariseRecording,
} from "../queries/recorderQuery";
import { formatDateTime } from "../utils/dateTime";
import { colors, mono } from "../utils/theme";

const SCREEN = Dimensions.get("window");

const STATUS_COLOR = {
	recording: colors.accent3,
	ready: colors.accent4,
	summarising: colors.accent,
	done: colors.accent2,
	failed: colors.accent3,
};

// Seconds → m:ss for segment timestamps.
const fmtClock = (s) => {
	const total = Math.max(0, Math.floor(s || 0));
	const m = Math.floor(total / 60);
	const sec = total % 60;
	return `${m}:${String(sec).padStart(2, "0")}`;
};

// Providers emit transcripts word-by-word. Coalesce consecutive segments into
// readable chunks: same speaker, ≤ MAX_GAP_S between them, up to MAX_WORDS
// words per chunk. Mirrors the web RecordingDetailPage.
const MAX_WORDS = 40;
const MAX_GAP_S = 3;

const tidy = (t) =>
	t
		.replace(/\s+([,.!?;:])/g, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();

const mergeSegments = (segs) => {
	const out = [];
	let cur = null;
	for (const s of segs) {
		const text = (s.text || "").trim();
		if (!text) continue;
		const speaker = s.speaker ?? null;
		const gap = cur ? s.t - cur.end : 0;
		const words = cur ? cur.text.split(/\s+/).length : 0;
		if (
			cur &&
			speaker === cur.speaker &&
			gap <= MAX_GAP_S &&
			words < MAX_WORDS
		) {
			cur.text += ` ${text}`;
			cur.end = s.end;
		} else {
			if (cur) out.push(cur);
			cur = { t: s.t, end: s.end, speaker, text };
		}
	}
	if (cur) out.push(cur);
	return out.map((g) => ({ ...g, text: tidy(g.text) }));
};

export default function RecordingDetailScreen({ navigation, route }) {
	const insets = useSafeAreaInsets();
	const id = route?.params?.id;
	const { data: rec, isLoading } = useRecording(id);
	const { data: transcript, isLoading: trLoading } = useRecordingTranscript(id);
	const summarise = useSummariseRecording();

	const segments = mergeSegments(
		(transcript?.segments || []).filter((s) => s.is_final),
	);
	const statusColor = STATUS_COLOR[rec?.status] || colors.muted;

	// 'ready' = transcript saved but never summarised (user chose "keep" after
	// stopping). 'failed' can be retried. Offer to summarise now.
	const canSummarise = rec?.status === "ready" || rec?.status === "failed";
	const runSummarise = () => {
		summarise.mutate(id, {
			onSuccess: () => toast.success("Summary saved to your vault"),
			onError: () => toast.error("Couldn't summarise the recording"),
		});
	};

	return (
		<View style={styles.root}>
			<PixelStarfield width={SCREEN.width} height={SCREEN.height} />

			<View style={[styles.bar, { paddingTop: insets.top + 12 }]}>
				<Pressable onPress={() => navigation.goBack()} hitSlop={10}>
					<Ionicons name="chevron-back" size={22} color={colors.text} />
				</Pressable>
				<Text style={styles.barTitle} numberOfLines={1}>
					{rec?.title || (isLoading ? "Loading…" : "Untitled recording")}
				</Text>
				{canSummarise ? (
					<Pressable
						onPress={summarise.isPending ? undefined : runSummarise}
						disabled={summarise.isPending}
						hitSlop={10}
					>
						{summarise.isPending ? (
							<ActivityIndicator size="small" color={colors.accent} />
						) : (
							<Ionicons
								name="sparkles-outline"
								size={20}
								color={colors.accent}
							/>
						)}
					</Pressable>
				) : rec?.final_note_id ? (
					<Pressable
						onPress={() =>
							navigation.navigate("VaultHome", { noteId: rec.final_note_id })
						}
						hitSlop={10}
					>
						<Ionicons
							name="document-text-outline"
							size={20}
							color={colors.accent2}
						/>
					</Pressable>
				) : (
					<View style={{ width: 20 }} />
				)}
			</View>

			<ScrollView
				contentContainerStyle={[
					styles.scroll,
					{ paddingBottom: insets.bottom + 24 },
				]}
			>
				{rec ? (
					<View style={styles.meta}>
						<View style={[styles.tag, { borderColor: statusColor }]}>
							<Text style={[styles.tagText, { color: statusColor }]}>
								{rec.status}
							</Text>
						</View>
						<Text style={styles.metaText}>
							{formatDateTime(rec.created_at).date}
						</Text>
						{rec.duration_secs > 0 && (
							<Text style={styles.metaText}>
								{Math.round(rec.duration_secs / 60)} min
							</Text>
						)}
						{rec.word_count > 0 && (
							<Text style={styles.metaText}>{rec.word_count} words</Text>
						)}
						{rec.provider ? (
							<Text style={styles.metaText}>{rec.provider}</Text>
						) : null}
					</View>
				) : null}

				{rec?.status === "failed" && rec.error ? (
					<View style={styles.panel}>
						<Text style={styles.panelTitle}>error</Text>
						<Text style={styles.errorText}>{rec.error}</Text>
					</View>
				) : null}

				{canSummarise ? (
					<Pressable
						style={styles.cta}
						disabled={summarise.isPending}
						onPress={runSummarise}
					>
						{summarise.isPending ? (
							<ActivityIndicator size="small" color={colors.bg} />
						) : (
							<>
								<Ionicons name="sparkles" size={16} color={colors.bg} />
								<Text style={styles.ctaText}>
									{rec?.status === "failed" ? "Retry summary" : "Summarize now"}
								</Text>
							</>
						)}
					</Pressable>
				) : null}

				{rec?.running_summary ? (
					<View style={styles.panel}>
						<Text style={styles.panelTitle}>summary</Text>
						<Text style={styles.summary}>{rec.running_summary}</Text>
					</View>
				) : null}

				<View style={styles.panel}>
					<Text style={styles.panelTitle}>transcript</Text>
					{trLoading ? (
						<ActivityIndicator color={colors.accent} style={{ marginTop: 8 }} />
					) : segments.length === 0 ? (
						<Text style={styles.muted}>
							{transcript?.ready === false
								? "Transcript not available yet — it's saved when the recording finishes."
								: "No transcript text."}
						</Text>
					) : (
						<View style={styles.transcript}>
							{segments.map((seg) => (
								<View
									key={`${seg.t}-${seg.end}-${seg.text}`}
									style={styles.seg}
								>
									<Text style={styles.segTime}>{fmtClock(seg.t)}</Text>
									<View style={styles.segBody}>
										{seg.speaker ? (
											<Text style={styles.segSpeaker}>{seg.speaker}</Text>
										) : null}
										<Text style={styles.segText}>{seg.text}</Text>
									</View>
								</View>
							))}
						</View>
					)}
				</View>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#0b0c10" },
	bar: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	barTitle: {
		color: colors.text,
		fontSize: 16,
		fontWeight: "600",
		flex: 1,
		marginHorizontal: 12,
	},
	scroll: { padding: 12, gap: 10 },
	cta: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		backgroundColor: colors.accent,
		paddingVertical: 12,
	},
	ctaText: {
		fontFamily: mono,
		color: colors.bg,
		fontSize: 13,
		fontWeight: "700",
		letterSpacing: 1,
		textTransform: "uppercase",
	},
	meta: {
		flexDirection: "row",
		flexWrap: "wrap",
		alignItems: "center",
		gap: 12,
	},
	metaText: { fontFamily: mono, color: colors.muted, fontSize: 12 },
	panel: {
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.border,
		padding: 12,
	},
	panelTitle: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 11,
		textTransform: "uppercase",
		letterSpacing: 1,
		marginBottom: 8,
	},
	summary: {
		color: colors.text,
		fontSize: 13,
		lineHeight: 22,
	},
	errorText: { color: colors.accent3, fontSize: 13, lineHeight: 20 },
	muted: { fontFamily: mono, color: colors.muted, fontSize: 13 },
	transcript: { gap: 10 },
	seg: { flexDirection: "row", gap: 10 },
	segTime: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 11,
		minWidth: 38,
		marginTop: 2,
	},
	segBody: { flex: 1 },
	segSpeaker: {
		fontFamily: mono,
		color: colors.accent4,
		fontSize: 11,
		fontWeight: "700",
		textTransform: "uppercase",
		marginBottom: 2,
	},
	segText: { color: colors.text, fontSize: 14, lineHeight: 21 },
	tag: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1 },
	tagText: {
		fontFamily: mono,
		fontSize: 10,
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 1,
	},
});
