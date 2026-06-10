import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../utils/theme";

// Shared top bar for the Settings screens — back chevron, title, and an
// optional right-side action. Mirrors the CalendarScreen header look.
export default function SettingsHeader({ title, onBack, right = null }) {
	const insets = useSafeAreaInsets();
	return (
		<View style={[styles.bar, { paddingTop: insets.top + 12 }]}>
			<Pressable onPress={onBack} hitSlop={10}>
				<Ionicons name="chevron-back" size={22} color={colors.text} />
			</Pressable>
			<Text style={styles.title} numberOfLines={1}>
				{title}
			</Text>
			<View style={styles.right}>{right}</View>
		</View>
	);
}

const styles = StyleSheet.create({
	bar: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
		backgroundColor: colors.bg,
	},
	title: {
		color: colors.text,
		fontSize: 17,
		fontWeight: "600",
		flex: 1,
		marginLeft: 12,
	},
	right: { flexDirection: "row", alignItems: "center", gap: 14 },
});
