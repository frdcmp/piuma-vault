import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, mono } from "../utils/theme";

// The standard top bar shared by every screen (Tasks, Calendar, Storage,
// Recorder) and the Settings stack — so they all match. A back affordance
// (chevron by default; pass `leftIcon` e.g. "close" for a contextual action
// bar), a title with an optional subtitle, and a right-hand action slot.
//
// Owns the status-bar inset (paddingTop), so screens must NOT also pad their
// root's top — let the bar handle it.
export default function ScreenHeader({
	title,
	subtitle = null,
	subtitleColor,
	icon = null,
	onBack,
	leftIcon = "chevron-back",
	right = null,
	style,
}) {
	const insets = useSafeAreaInsets();
	return (
		<View style={[styles.bar, { paddingTop: insets.top + 12 }, style]}>
			{onBack ? (
				<Pressable onPress={onBack} hitSlop={10} style={styles.back}>
					<Ionicons name={leftIcon} size={22} color={colors.text} />
				</Pressable>
			) : null}
			{icon ? (
				<Ionicons
					name={icon}
					size={20}
					color={colors.accent}
					style={styles.icon}
				/>
			) : null}
			<View style={styles.titleWrap}>
				<Text style={styles.title} numberOfLines={1}>
					{title}
				</Text>
				{subtitle ? (
					<Text
						style={[
							styles.subtitle,
							subtitleColor ? { color: subtitleColor } : null,
						]}
						numberOfLines={1}
					>
						{subtitle}
					</Text>
				) : null}
			</View>
			{right ? <View style={styles.right}>{right}</View> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	bar: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 16,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
		backgroundColor: colors.bg,
	},
	back: { marginRight: 4 },
	icon: { marginLeft: 8 },
	titleWrap: { flex: 1, marginLeft: 8 },
	title: { color: colors.text, fontSize: 17, fontWeight: "600" },
	subtitle: {
		color: colors.muted,
		fontFamily: mono,
		fontSize: 10,
		letterSpacing: 0.5,
		marginTop: 1,
	},
	right: { flexDirection: "row", alignItems: "center", gap: 14 },
});
