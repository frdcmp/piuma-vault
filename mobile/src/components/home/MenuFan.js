import { useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, mono } from "../../utils/theme";
import FloatingMascot from "./FloatingMascot";
import { toneColor } from "./menuItems";
import QuipTerminal from "./QuipTerminal";

// Items spring out of a bottom-right corner button along a quarter-arc, every
// one inside thumb reach. Tap the button to fan out/in; tap an item to open it.
export default function MenuFan({ items, name, onMascotTap }) {
	const [open, setOpen] = useState(false);
	const progress = useRef(new Animated.Value(0)).current;

	const toggle = () => {
		const next = !open;
		setOpen(next);
		Animated.spring(progress, {
			toValue: next ? 1 : 0,
			useNativeDriver: true,
			speed: 12,
			bounciness: 6,
		}).start();
	};

	const n = items.length;

	return (
		<View style={styles.container}>
			{/* Seat the mascot in the upper band, clear of the fan that sweeps up
			    from the bottom-right corner. Flex spacers keep it proportional. */}
			<View style={styles.spacerTop} />
			<View style={styles.head}>
				<FloatingMascot name={name} pixelSize={7} onTap={onMascotTap} />
				<QuipTerminal name={name} />
			</View>
			<View style={styles.spacerBottom} />

			{/* Tap-away catcher so an open fan closes when you tap empty space. */}
			{open && <Pressable style={StyleSheet.absoluteFill} onPress={toggle} />}

			<View style={styles.fanAnchor} pointerEvents="box-none">
				{items.map((it, i) => {
					// Grow radius + sweep angle per index so items ladder out toward the
					// upper-left without overlapping.
					const angle = (200 + (i * 60) / (n - 1)) * (Math.PI / 180);
					const dist = 84 + i * 54;
					const tx = Math.cos(angle) * dist;
					const ty = Math.sin(angle) * dist;
					const start = (i * 0.5) / n;
					const seg = progress.interpolate({
						inputRange: [start, Math.min(1, start + 0.6)],
						outputRange: [0, 1],
						extrapolate: "clamp",
					});
					return (
						<Animated.View
							key={it.key}
							style={[
								styles.fanItem,
								{
									opacity: seg,
									transform: [
										{
											translateX: seg.interpolate({
												inputRange: [0, 1],
												outputRange: [0, tx],
											}),
										},
										{
											translateY: seg.interpolate({
												inputRange: [0, 1],
												outputRange: [0, ty],
											}),
										},
										{ scale: seg },
									],
								},
							]}
							pointerEvents={open ? "auto" : "none"}
						>
							<Pressable
								onPress={() => {
									toggle();
									it.onPress?.();
								}}
								style={({ pressed }) => [
									styles.pill,
									pressed && styles.pillPressed,
								]}
							>
								<Text
									style={[
										styles.label,
										it.tone === "danger" && styles.dangerText,
									]}
								>
									{it.label}
								</Text>
								<Text style={[styles.glyph, { color: toneColor(it.tone) }]}>
									{it.glyph}
								</Text>
							</Pressable>
						</Animated.View>
					);
				})}

				<Pressable onPress={toggle} style={styles.fab}>
					<Animated.Text
						style={[
							styles.fabGlyph,
							{
								transform: [
									{
										rotate: progress.interpolate({
											inputRange: [0, 1],
											outputRange: ["0deg", "135deg"],
										}),
									},
								],
							},
						]}
					>
						✦
					</Animated.Text>
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, alignItems: "center" },
	spacerTop: { flex: 2 },
	spacerBottom: { flex: 9 },
	head: { alignItems: "center", gap: 16 },
	fanAnchor: {
		position: "absolute",
		right: 28,
		bottom: 36,
		width: 56,
		height: 56,
		alignItems: "center",
		justifyContent: "center",
	},
	fanItem: { position: "absolute" },
	pill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderWidth: 1,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
		minWidth: 120,
		justifyContent: "flex-end",
	},
	pillPressed: { borderColor: colors.accent, opacity: 0.7 },
	glyph: {
		fontFamily: mono,
		fontSize: 16,
		fontWeight: "700",
		width: 18,
		textAlign: "center",
	},
	label: {
		color: colors.accent2,
		fontFamily: mono,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1,
		textTransform: "uppercase",
	},
	dangerText: { color: colors.accent3 },
	fab: {
		width: 56,
		height: 56,
		borderRadius: 28,
		borderWidth: 2,
		borderColor: colors.accent,
		backgroundColor: colors.panel,
		alignItems: "center",
		justifyContent: "center",
	},
	fabGlyph: {
		color: colors.accent,
		fontFamily: mono,
		fontSize: 24,
		fontWeight: "700",
	},
});
