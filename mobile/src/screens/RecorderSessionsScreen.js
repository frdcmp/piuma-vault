import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
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
import ConfirmModal from "../components/ConfirmModal";
import PixelStarfield from "../components/PixelStarfield";
import { toast } from "../components/Toast";
import {
	useDeleteRecording,
	useRecorderUsage,
	useRecordings,
} from "../queries/recorderQuery";
import { formatDateTime } from "../utils/dateTime";
import { colors, mono } from "../utils/theme";

const SCREEN = Dimensions.get("window");

const STATUS_COLOR = {
	recording: colors.accent3,
	summarising: colors.accent,
	done: colors.accent2,
	failed: colors.accent3,
};

const fmtDur = (sec) => {
	const m = Math.round((sec || 0) / 60);
	const h = Math.floor(m / 60);
	return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
};

function StatusTag({ status }) {
	const color = STATUS_COLOR[status] || colors.muted;
	return (
		<View style={[styles.tag, { borderColor: color }]}>
			<Text style={[styles.tagText, { color }]}>{status}</Text>
		</View>
	);
}

// This-month transcription usage per provider, gauged against the provider's
// free-tier cap (Speechmatics 40h/mo). Mirrors the web UsagePanel.
function UsagePanel() {
	const { data } = useRecorderUsage();
	const months = data?.months || [];
	const freeHours = data?.free_hours || {};
	if (months.length === 0) return null;

	const latest = months[0].month;
	const current = months.filter((m) => m.month === latest);

	return (
		<View style={styles.panel}>
			<Text style={styles.panelTitle}>usage · {latest}</Text>
			{current.map((row) => {
				const hours = row.seconds / 3600;
				const cap = freeHours[row.provider];
				const pct = cap ? Math.min(100, (hours / cap) * 100) : 0;
				const over = cap && hours > cap;
				return (
					<View key={row.provider} style={styles.usageRow}>
						<View style={styles.usageHead}>
							<Text style={styles.usageName}>{row.provider}</Text>
							<Text style={styles.usageVal}>
								{fmtDur(row.seconds)}
								{cap ? ` / ${cap}h free` : ""} · {row.sessions} rec
							</Text>
						</View>
						{cap > 0 && (
							<View style={styles.usageBar}>
								<View
									style={[
										styles.usageFill,
										{ width: `${pct}%` },
										over && styles.usageFillOver,
									]}
								/>
							</View>
						)}
					</View>
				);
			})}
		</View>
	);
}

export default function RecorderSessionsScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const { data: recordings = [], isLoading } = useRecordings();
	const deleteRecording = useDeleteRecording();
	// The recording awaiting delete confirmation (drives the pv modal); also
	// the id we show a row spinner on while the mutation is in flight.
	const [pending, setPending] = useState(null);
	const deletingId = deleteRecording.isPending ? pending?.id : null;

	const runDelete = () => {
		if (!pending) return;
		deleteRecording.mutate(pending.id, {
			onSuccess: () => {
				setPending(null);
				toast.success("Recording deleted");
			},
			onError: () => toast.error("Couldn't delete recording"),
		});
	};

	return (
		<View style={styles.root}>
			<PixelStarfield width={SCREEN.width} height={SCREEN.height} />

			<View style={[styles.bar, { paddingTop: insets.top + 12 }]}>
				<Pressable onPress={() => navigation.goBack()} hitSlop={10}>
					<Ionicons name="chevron-back" size={22} color={colors.text} />
				</Pressable>
				<Text style={styles.title}>Recorded Sessions</Text>
				<View style={{ width: 22 }} />
			</View>

			<ScrollView
				contentContainerStyle={[
					styles.scroll,
					{ paddingBottom: insets.bottom + 24 },
				]}
			>
				<Text style={styles.subtitle}>
					Every capture — transcript and summary note included.
				</Text>

				<UsagePanel />

				{isLoading ? (
					<ActivityIndicator color={colors.accent} style={styles.loader} />
				) : recordings.length === 0 ? (
					<Text style={styles.empty}>
						Nothing here yet — feed the black hole.
					</Text>
				) : (
					recordings.map((r) => {
						const { date, time } = formatDateTime(r.created_at);
						return (
							<View key={r.id} style={styles.item}>
								<Pressable
									style={styles.itemMain}
									onPress={() =>
										navigation.navigate("RecordingDetail", { id: r.id })
									}
								>
									<View style={styles.itemTitleRow}>
										<Text style={styles.itemTitle} numberOfLines={1}>
											{r.title || "Untitled recording"}
										</Text>
										<StatusTag status={r.status} />
									</View>
									<View style={styles.itemMeta}>
										<Text style={styles.metaText}>
											{date} {time}
										</Text>
										{r.duration_secs > 0 && (
											<Text style={styles.metaText}>
												{Math.round(r.duration_secs / 60)} min
											</Text>
										)}
										{r.word_count > 0 && (
											<Text style={styles.metaText}>{r.word_count} words</Text>
										)}
									</View>
									{r.preview ? (
										<Text style={styles.preview} numberOfLines={2}>
											{r.preview}
										</Text>
									) : null}
									{r.status === "failed" && r.error ? (
										<Text style={styles.error}>{r.error}</Text>
									) : null}
								</Pressable>
								<View style={styles.itemActions}>
									{r.final_note_id ? (
										<Pressable
											style={styles.actionBtn}
											onPress={() =>
												navigation.navigate("VaultHome", {
													noteId: r.final_note_id,
												})
											}
										>
											<Ionicons
												name="document-text-outline"
												size={16}
												color={colors.accent2}
											/>
										</Pressable>
									) : null}
									<Pressable
										style={styles.actionBtn}
										disabled={deletingId === r.id}
										onPress={() => setPending(r)}
									>
										{deletingId === r.id ? (
											<ActivityIndicator size="small" color={colors.accent3} />
										) : (
											<Ionicons
												name="trash-outline"
												size={16}
												color={colors.accent3}
											/>
										)}
									</Pressable>
								</View>
							</View>
						);
					})
				)}
			</ScrollView>

			<ConfirmModal
				visible={!!pending}
				title="Delete recording?"
				message="This removes the transcript and moves its summary note to Trash."
				confirmText="Delete"
				loading={deleteRecording.isPending}
				onConfirm={runDelete}
				onCancel={() => setPending(null)}
			/>
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
	title: {
		color: colors.text,
		fontSize: 17,
		fontWeight: "600",
		flex: 1,
		marginLeft: 12,
	},
	scroll: { padding: 12, gap: 10 },
	subtitle: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 12,
		marginBottom: 2,
	},
	loader: { marginTop: 32 },
	empty: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 13,
		textAlign: "center",
		marginTop: 32,
	},
	panel: {
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.border,
		padding: 12,
		gap: 10,
	},
	panelTitle: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 11,
		textTransform: "uppercase",
		letterSpacing: 1,
		marginBottom: 2,
	},
	usageRow: { gap: 5 },
	usageHead: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "baseline",
		gap: 12,
	},
	usageName: {
		fontFamily: mono,
		color: colors.text,
		fontSize: 13,
		fontWeight: "700",
		textTransform: "capitalize",
	},
	usageVal: { fontFamily: mono, color: colors.muted, fontSize: 11 },
	usageBar: {
		height: 12,
		borderWidth: 2,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		overflow: "hidden",
	},
	usageFill: { height: "100%", backgroundColor: colors.accent2 },
	usageFillOver: { backgroundColor: colors.accent3 },
	item: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 12,
		borderWidth: 2,
		borderColor: colors.border,
		backgroundColor: "rgba(21,23,28,0.88)",
		padding: 12,
	},
	itemMain: { flex: 1, minWidth: 0 },
	itemTitleRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		flexWrap: "wrap",
	},
	itemTitle: {
		fontFamily: mono,
		color: colors.text,
		fontSize: 14,
		fontWeight: "700",
		flexShrink: 1,
	},
	itemMeta: { flexDirection: "row", flexWrap: "wrap", gap: 14, marginTop: 6 },
	metaText: { fontFamily: mono, color: colors.muted, fontSize: 11 },
	preview: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 12,
		lineHeight: 18,
		marginTop: 8,
	},
	error: {
		fontFamily: mono,
		color: colors.accent3,
		fontSize: 12,
		marginTop: 8,
	},
	itemActions: { flexDirection: "row", gap: 8 },
	actionBtn: {
		borderWidth: 2,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		padding: 8,
	},
	tag: {
		borderWidth: 1,
		paddingHorizontal: 6,
		paddingVertical: 1,
	},
	tagText: {
		fontFamily: mono,
		fontSize: 10,
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 1,
	},
});
