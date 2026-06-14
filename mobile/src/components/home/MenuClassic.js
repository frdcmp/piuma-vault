import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, mono } from "../../utils/theme";
import FloatingMascot from "./FloatingMascot";
import { toneColor } from "./menuItems";
import QuipTerminal from "./QuipTerminal";

// A row of chevrons that fades in sequence to imply a swipe direction.
function SwipeChevrons({ dir }) {
	const left = dir === "left";
	const chevs = useRef(
		[`${dir}-0`, `${dir}-1`, `${dir}-2`].map((id) => ({
			id,
			val: new Animated.Value(0.25),
		})),
	).current;

	useEffect(() => {
		const ordered = left ? [...chevs].reverse() : chevs;
		const loop = Animated.loop(
			Animated.stagger(
				140,
				ordered.map((c) =>
					Animated.sequence([
						Animated.timing(c.val, {
							toValue: 1,
							duration: 180,
							useNativeDriver: true,
						}),
						Animated.timing(c.val, {
							toValue: 0.25,
							duration: 420,
							useNativeDriver: true,
						}),
					]),
				),
			),
		);
		loop.start();
		return () => loop.stop();
	}, [chevs, left]);

	const glyph = left ? "‹" : "›";
	return (
		<View style={styles.chevronRow}>
			{chevs.map((c) => (
				<Animated.Text key={c.id} style={[styles.chevron, { opacity: c.val }]}>
					{glyph}
				</Animated.Text>
			))}
		</View>
	);
}

// The original vertical menu: floating mascot, terminal quip, a notes/chat
// "swipe" row, then a stacked list of the remaining destinations.
export default function MenuClassic({ items, name, onMascotTap }) {
	const byKey = Object.fromEntries(items.map((it) => [it.key, it]));
	const stacked = items.filter((it) => it.key !== "notes" && it.key !== "chat");

	return (
		<View style={styles.container}>
			<FloatingMascot name={name} pixelSize={8} onTap={onMascotTap} />
			<QuipTerminal name={name} />
			<View style={styles.hintRow}>
				<Pressable
					onPress={byKey.notes?.onPress}
					style={({ pressed }) => [
						styles.hintPill,
						pressed && styles.hintPillPressed,
					]}
				>
					<SwipeChevrons dir="left" />
					<Text style={styles.hintText}>notes</Text>
				</Pressable>
				<Text style={styles.hintPaw}>🐾</Text>
				<Pressable
					onPress={byKey.chat?.onPress}
					style={({ pressed }) => [
						styles.hintPill,
						pressed && styles.hintPillPressed,
					]}
				>
					<Text style={styles.hintText}>chat</Text>
					<SwipeChevrons dir="right" />
				</Pressable>
			</View>
			<View style={styles.menuList}>
				{stacked.map((it) => (
					<Pressable
						key={it.key}
						onPress={it.onPress}
						style={({ pressed }) => [
							styles.menuItem,
							pressed && styles.menuItemPressed,
						]}
					>
						<Text style={[styles.glyph, { color: toneColor(it.tone) }]}>
							{it.glyph}
						</Text>
						<Text
							style={[
								styles.hintText,
								it.tone === "danger" && styles.dangerText,
							]}
						>
							{it.label}
						</Text>
					</Pressable>
				))}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		gap: 44,
		paddingHorizontal: 24,
	},
	hintRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
	},
	hintPill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderWidth: 1,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	hintPillPressed: {
		backgroundColor: colors.bg,
		borderColor: colors.accent,
	},
	menuList: {
		alignItems: "center",
		marginTop: 8,
		gap: 16,
	},
	menuItem: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 10,
		paddingVertical: 4,
	},
	menuItemPressed: { opacity: 0.45 },
	glyph: {
		fontFamily: mono,
		fontSize: 14,
		fontWeight: "700",
		width: 18,
		textAlign: "center",
	},
	hintText: {
		color: colors.accent2,
		fontFamily: mono,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1,
		textTransform: "uppercase",
	},
	dangerText: { color: colors.accent3 },
	chevronRow: { flexDirection: "row" },
	chevron: {
		color: colors.accent,
		fontFamily: mono,
		fontSize: 14,
		fontWeight: "700",
		lineHeight: 14,
	},
	hintPaw: { fontSize: 14, opacity: 0.8 },
});
