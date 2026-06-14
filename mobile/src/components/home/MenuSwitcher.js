import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, mono } from "../../utils/theme";
import { HOME_MENUS } from "./index";

// Compact inline picker pinned to the top of the home screen: ‹ DOTS LABEL ›.
// Arrows cycle through layouts; tapping a dot jumps straight to one.
export default function MenuSwitcher({ value, onChange }) {
	const index = Math.max(
		0,
		HOME_MENUS.findIndex((m) => m.key === value),
	);
	const go = (delta) => {
		const next = (index + delta + HOME_MENUS.length) % HOME_MENUS.length;
		onChange(HOME_MENUS[next].key);
	};

	return (
		<View style={styles.bar}>
			<Pressable onPress={() => go(-1)} hitSlop={10} style={styles.arrowHit}>
				<Text style={styles.arrow}>‹</Text>
			</Pressable>
			<View style={styles.dots}>
				{HOME_MENUS.map((m, i) => (
					<Pressable key={m.key} onPress={() => onChange(m.key)} hitSlop={8}>
						<Text style={[styles.dot, i === index && styles.dotActive]}>
							{i === index ? "●" : "○"}
						</Text>
					</Pressable>
				))}
			</View>
			<Text style={styles.label}>{HOME_MENUS[index]?.label}</Text>
			<Pressable onPress={() => go(1)} hitSlop={10} style={styles.arrowHit}>
				<Text style={styles.arrow}>›</Text>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	bar: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 12,
		paddingVertical: 6,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
	},
	arrowHit: { paddingHorizontal: 2 },
	arrow: {
		color: colors.accent,
		fontFamily: mono,
		fontSize: 18,
		fontWeight: "700",
		lineHeight: 18,
	},
	dots: { flexDirection: "row", gap: 4, alignItems: "center" },
	dot: { color: colors.muted, fontFamily: mono, fontSize: 9, opacity: 0.6 },
	dotActive: { color: colors.accent2, opacity: 1 },
	label: {
		color: colors.accent2,
		fontFamily: mono,
		fontSize: 10,
		fontWeight: "700",
		letterSpacing: 1.5,
		textTransform: "uppercase",
		minWidth: 64,
		textAlign: "center",
	},
});
