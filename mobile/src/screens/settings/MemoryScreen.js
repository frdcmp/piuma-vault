import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ConfirmModal from "../../components/ConfirmModal";
import SettingsHeader from "../../components/SettingsHeader";
import {
	useConfirmMemoryEntry,
	useDeleteMemoryEntry,
	useMemoryEntriesInfinite,
	useMemoryOverview,
	useRejectMemoryEntry,
} from "../../queries/memoryQuery";
import { colors, mono } from "../../utils/theme";

const STATUSES = [
	{ key: "pending", label: "pending" },
	{ key: "confirmed", label: "confirmed" },
	{ key: "rejected", label: "rejected" },
];

const fmtInt = (n) =>
	String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function Gauge({ label, pct, chars, cap }) {
	const clamped = Math.max(0, Math.min(100, pct || 0));
	return (
		<View style={styles.gauge}>
			<View style={styles.gaugeHead}>
				<Text style={styles.gaugeLabel}>{label}</Text>
				<Text style={styles.gaugeMeta}>
					{fmtInt(chars)}/{fmtInt(cap)} · {clamped}%
				</Text>
			</View>
			<View style={styles.track}>
				<View
					style={[
						styles.fill,
						{ width: `${clamped}%` },
						clamped > 85 && styles.fillHot,
					]}
				/>
			</View>
		</View>
	);
}

function CountTag({ label, value }) {
	return (
		<View style={styles.countTag}>
			<Text style={styles.countValue}>{fmtInt(value)}</Text>
			<Text style={styles.countLabel}>{label}</Text>
		</View>
	);
}

export default function MemoryScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const [status, setStatus] = useState("pending");
	const [pendingDelete, setPendingDelete] = useState(null);

	const { data: overview, isLoading: ovLoading } = useMemoryOverview();
	const {
		data: pages,
		isLoading: enLoading,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useMemoryEntriesInfinite({ status });

	const confirm = useConfirmMemoryEntry();
	const reject = useRejectMemoryEntry();
	const del = useDeleteMemoryEntry();

	// Flatten the loaded pages into one list for the FlatList.
	const list = pages?.pages.flat() || [];
	const stats = overview?.stats;
	const l1 = overview?.l1;
	const l3 = overview?.l3;

	const confirmDelete = () => {
		const e = pendingDelete;
		setPendingDelete(null);
		if (e) del.mutate(e.id);
	};

	const renderEntry = ({ item: e }) => (
		<View style={styles.entry}>
			<Text style={styles.entryContent}>{e.content}</Text>
			<View style={styles.entryTags}>
				{e.category ? <Text style={styles.metaTag}>{e.category}</Text> : null}
				<Text style={styles.metaTag}>{e.source}</Text>
			</View>
			<View style={styles.actions}>
				{status !== "confirmed" ? (
					<Pressable
						onPress={() => confirm.mutate(e.id)}
						style={styles.actionBtn}
						hitSlop={6}
					>
						<Ionicons name="checkmark" size={18} color={colors.accent2} />
						<Text style={[styles.actionText, styles.confirmText]}>confirm</Text>
					</Pressable>
				) : null}
				{status !== "rejected" ? (
					<Pressable
						onPress={() => reject.mutate(e.id)}
						style={styles.actionBtn}
						hitSlop={6}
					>
						<Ionicons name="close" size={18} color={colors.muted} />
						<Text style={styles.actionText}>reject</Text>
					</Pressable>
				) : null}
				<Pressable
					onPress={() => setPendingDelete(e)}
					style={styles.actionBtn}
					hitSlop={6}
				>
					<Ionicons name="trash-outline" size={18} color={colors.accent3} />
					<Text style={[styles.actionText, styles.deleteText]}>delete</Text>
				</Pressable>
			</View>
		</View>
	);

	// Overview + filter chips ride above the entries as the list header so the
	// whole screen scrolls as one and the entries can paginate.
	const header = (
		<View style={styles.header}>
			{ovLoading ? (
				<ActivityIndicator color={colors.accent} style={styles.loader} />
			) : (
				<>
					<Text style={styles.sectionTitle}>L1 · always in context</Text>
					<View style={styles.panel}>
						<Gauge
							label="memory"
							pct={l1?.memory_pct}
							chars={l1?.memory_chars}
							cap={l1?.memory_cap}
						/>
						<Gauge
							label="user context"
							pct={l1?.user_context_pct}
							chars={l1?.user_context_chars}
							cap={l1?.user_context_cap}
						/>
					</View>

					<Text style={styles.sectionTitle}>Store</Text>
					<View style={styles.counts}>
						<CountTag label="confirmed" value={stats?.by_status?.confirmed} />
						<CountTag label="pending" value={stats?.by_status?.pending} />
						<CountTag label="rejected" value={stats?.by_status?.rejected} />
						<CountTag label="convos" value={l3?.conversations} />
						<CountTag label="messages" value={l3?.messages} />
					</View>
				</>
			)}

			<Text style={styles.sectionTitle}>Entries</Text>
			<View style={styles.chips}>
				{STATUSES.map((st) => {
					const active = st.key === status;
					return (
						<Pressable
							key={st.key}
							onPress={() => setStatus(st.key)}
							style={[styles.chip, active && styles.chipActive]}
						>
							<Text style={[styles.chipText, active && styles.chipTextActive]}>
								{st.label}
							</Text>
						</Pressable>
					);
				})}
			</View>
		</View>
	);

	return (
		<View style={styles.root}>
			<SettingsHeader title="Memory" onBack={() => navigation.goBack()} />
			<FlatList
				data={list}
				keyExtractor={(item) => item.id}
				renderItem={renderEntry}
				ListHeaderComponent={header}
				contentContainerStyle={[
					styles.scroll,
					{ paddingBottom: insets.bottom + 24 },
				]}
				onEndReachedThreshold={0.4}
				onEndReached={() => {
					if (hasNextPage && !isFetchingNextPage) fetchNextPage();
				}}
				ListEmptyComponent={
					enLoading ? (
						<ActivityIndicator color={colors.accent} style={styles.loader} />
					) : (
						<Text style={styles.empty}>No {status} entries.</Text>
					)
				}
				ListFooterComponent={
					isFetchingNextPage ? (
						<ActivityIndicator color={colors.accent} style={styles.footer} />
					) : null
				}
			/>

			<ConfirmModal
				visible={pendingDelete != null}
				title="Delete memory"
				message="Permanently delete this memory entry? This cannot be undone."
				confirmText="Delete"
				onConfirm={confirmDelete}
				onCancel={() => setPendingDelete(null)}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: colors.bg },
	scroll: { padding: 12, gap: 8 },
	header: { gap: 8 },
	loader: { marginTop: 24 },
	footer: { marginVertical: 16 },
	sectionTitle: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 12,
		textTransform: "uppercase",
		letterSpacing: 1,
		marginTop: 12,
		marginBottom: 4,
		marginLeft: 4,
	},
	panel: {
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.border,
		padding: 14,
		gap: 14,
	},
	gauge: { gap: 6 },
	gaugeHead: { flexDirection: "row", justifyContent: "space-between" },
	gaugeLabel: {
		fontFamily: mono,
		color: colors.text,
		fontSize: 13,
		textTransform: "uppercase",
		letterSpacing: 1,
	},
	gaugeMeta: { fontFamily: mono, color: colors.muted, fontSize: 12 },
	track: {
		height: 10,
		backgroundColor: colors.bgSoft,
		borderWidth: 1,
		borderColor: colors.border,
	},
	fill: { height: "100%", backgroundColor: colors.accent2 },
	fillHot: { backgroundColor: colors.accent3 },
	counts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	countTag: {
		flexGrow: 1,
		flexBasis: "30%",
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.border,
		padding: 10,
		alignItems: "center",
	},
	countValue: {
		fontFamily: mono,
		color: colors.accent,
		fontSize: 18,
		fontWeight: "700",
	},
	countLabel: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 11,
		textTransform: "uppercase",
		marginTop: 2,
	},
	chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	chip: {
		paddingHorizontal: 12,
		paddingVertical: 7,
		borderWidth: 2,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
	},
	chipActive: { borderColor: colors.accent, backgroundColor: colors.bg },
	chipText: { fontFamily: mono, color: colors.muted, fontSize: 13 },
	chipTextActive: { color: colors.accent, fontWeight: "700" },
	empty: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 14,
		textAlign: "center",
		padding: 24,
	},
	entry: {
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.border,
		padding: 14,
		gap: 10,
	},
	entryContent: {
		fontFamily: mono,
		color: colors.text,
		fontSize: 14,
		lineHeight: 20,
	},
	entryTags: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
	metaTag: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 11,
		borderWidth: 1,
		borderColor: colors.border,
		paddingHorizontal: 6,
		paddingVertical: 2,
	},
	actions: {
		flexDirection: "row",
		gap: 16,
		borderTopWidth: 1,
		borderTopColor: colors.border,
		paddingTop: 10,
	},
	actionBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
	actionText: { fontFamily: mono, color: colors.muted, fontSize: 12 },
	confirmText: { color: colors.accent2 },
	deleteText: { color: colors.accent3 },
});
