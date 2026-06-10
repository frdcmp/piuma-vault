import dayjs from "dayjs";
import { useMemo, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import SettingsHeader from "../../components/SettingsHeader";
import { useTokenUsage } from "../../queries/tokenUsageQuery";
import { colors, mono } from "../../utils/theme";

// Date-range presets. `days: null` = all time (no `from` filter).
const RANGES = [
	{ key: "7d", label: "7 days", days: 7 },
	{ key: "30d", label: "30 days", days: 30 },
	{ key: "all", label: "all time", days: null },
];

// Thousands separators without Intl (Hermes has limited Intl support).
const fmtInt = (n) =>
	String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// Costs ≥ 1¢ read as plain dollars; tiny spend (e.g. embeddings, a few hundred
// tokens at $0.13/M) would round to $0.00, so show it in exponential form
// (e.g. $5.23e-5) instead of hiding it.
const fmtCost = (n) => {
	const v = n || 0;
	if (v === 0) return "$0.00";
	if (v >= 0.01) return `$${v.toFixed(2)}`;
	return `$${v.toExponential(2)}`;
};

function StatCard({ label, value, accent }) {
	return (
		<View style={styles.stat}>
			<Text style={styles.statLabel}>{label}</Text>
			<Text style={[styles.statValue, accent && styles.statValueAccent]}>
				{value}
			</Text>
		</View>
	);
}

function Breakdown({ title, rows, nameKey }) {
	if (!rows?.length) return null;
	return (
		<>
			<Text style={styles.sectionTitle}>{title}</Text>
			<View style={styles.panel}>
				{rows.map((r, i) => (
					<View
						key={`${r[nameKey]}-${i}`}
						style={[styles.row, i > 0 && styles.rowBorder]}
					>
						<View style={styles.rowText}>
							<Text style={styles.rowName} numberOfLines={1}>
								{r[nameKey] || "—"}
							</Text>
							<Text style={styles.rowMeta}>
								{fmtInt(r.total_tokens)} tokens · {fmtInt(r.calls)} calls
							</Text>
						</View>
						<Text style={styles.rowCost}>{fmtCost(r.cost_usd)}</Text>
					</View>
				))}
			</View>
		</>
	);
}

export default function TokenUsageScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const [range, setRange] = useState("30d");

	const params = useMemo(() => {
		const r = RANGES.find((x) => x.key === range);
		if (!r?.days) return {};
		return { from: dayjs().subtract(r.days, "day").format("YYYY-MM-DD") };
	}, [range]);

	const { data, isLoading } = useTokenUsage(params);
	const s = data?.summary;

	return (
		<View style={styles.root}>
			<SettingsHeader title="Token usage" onBack={() => navigation.goBack()} />
			<ScrollView
				contentContainerStyle={[
					styles.scroll,
					{ paddingBottom: insets.bottom + 24 },
				]}
			>
				<View style={styles.chips}>
					{RANGES.map((r) => {
						const active = r.key === range;
						return (
							<Pressable
								key={r.key}
								onPress={() => setRange(r.key)}
								style={[styles.chip, active && styles.chipActive]}
							>
								<Text
									style={[styles.chipText, active && styles.chipTextActive]}
								>
									{r.label}
								</Text>
							</Pressable>
						);
					})}
				</View>

				{isLoading ? (
					<ActivityIndicator color={colors.accent} style={styles.loader} />
				) : (
					<>
						<View style={styles.grid}>
							<StatCard
								label="cost (est.)"
								value={fmtCost(s?.cost_usd)}
								accent
							/>
							<StatCard label="total tokens" value={fmtInt(s?.total_tokens)} />
							<StatCard label="input" value={fmtInt(s?.tokens_input)} />
							<StatCard label="output" value={fmtInt(s?.tokens_output)} />
							<StatCard label="cached" value={fmtInt(s?.tokens_cached)} />
							<StatCard label="calls" value={fmtInt(s?.calls)} />
						</View>

						<Breakdown title="By model" rows={data?.by_model} nameKey="model" />
						<Breakdown
							title="By source"
							rows={data?.by_source}
							nameKey="source"
						/>
					</>
				)}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: colors.bg },
	scroll: { padding: 12, gap: 8 },
	loader: { marginTop: 32 },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
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
	grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	stat: {
		flexGrow: 1,
		flexBasis: "47%",
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.border,
		padding: 12,
	},
	statLabel: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 11,
		textTransform: "uppercase",
		letterSpacing: 1,
	},
	statValue: {
		fontFamily: mono,
		color: colors.text,
		fontSize: 20,
		fontWeight: "700",
		marginTop: 4,
	},
	statValueAccent: { color: colors.accent },
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
	},
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		padding: 12,
	},
	rowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
	rowText: { flex: 1 },
	rowName: { fontFamily: mono, color: colors.text, fontSize: 14 },
	rowMeta: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 12,
		marginTop: 2,
	},
	rowCost: { fontFamily: mono, color: colors.accent2, fontSize: 14 },
});
