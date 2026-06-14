import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, mono } from "../../utils/theme";
import FloatingMascot from "./FloatingMascot";
import { toneColor } from "./menuItems";
import QuipTerminal from "./QuipTerminal";

// Normalized star positions (0..1 of the available area). Kept below the top
// header band so the mascot/quip stay clear. Index order matches buildHomeItems.
const POS = [
	{ x: 0.2, y: 0.34 },
	{ x: 0.52, y: 0.28 },
	{ x: 0.82, y: 0.36 },
	{ x: 0.32, y: 0.54 },
	{ x: 0.68, y: 0.56 },
	{ x: 0.2, y: 0.76 },
	{ x: 0.55, y: 0.78 },
	{ x: 0.84, y: 0.82 },
];

// A thin line between two points, drawn as a rotated View (no SVG dependency).
function Link({ x1, y1, x2, y2 }) {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const len = Math.hypot(dx, dy);
	const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
	return (
		<View
			style={[
				styles.link,
				{
					left: (x1 + x2) / 2 - len / 2,
					top: (y1 + y2) / 2 - 0.5,
					width: len,
					transform: [{ rotate: `${angle}deg` }],
				},
			]}
		/>
	);
}

function Star({ item, x, y, delay }) {
	const twinkle = useRef(new Animated.Value(0.5)).current;
	const pop = useRef(new Animated.Value(1)).current;

	useEffect(() => {
		const loop = Animated.loop(
			Animated.sequence([
				Animated.timing(twinkle, {
					toValue: 1,
					duration: 900,
					delay,
					useNativeDriver: true,
				}),
				Animated.timing(twinkle, {
					toValue: 0.4,
					duration: 900,
					useNativeDriver: true,
				}),
			]),
		);
		loop.start();
		return () => loop.stop();
	}, [twinkle, delay]);

	const warp = () => {
		Animated.sequence([
			Animated.timing(pop, {
				toValue: 1.8,
				duration: 140,
				useNativeDriver: true,
			}),
			Animated.timing(pop, {
				toValue: 1,
				duration: 160,
				useNativeDriver: true,
			}),
		]).start();
		item.onPress?.();
	};

	return (
		<View style={[styles.starSlot, { left: x - 44, top: y - 24 }]}>
			<Pressable onPress={warp} style={styles.star}>
				<Animated.Text
					style={[
						styles.starGlyph,
						{
							color: toneColor(item.tone),
							opacity: twinkle,
							transform: [{ scale: pop }],
						},
					]}
				>
					✦
				</Animated.Text>
				<Text
					style={[styles.label, item.tone === "danger" && styles.dangerText]}
				>
					{item.label}
				</Text>
			</Pressable>
		</View>
	);
}

// Destinations are stars on a star-map; lines connect them like a constellation.
// Tap a star to warp there.
export default function MenuConstellation({ items, name, dims, onMascotTap }) {
	const w = dims?.width || 320;
	const h = dims?.height || 560;
	const pts = items.map((_, i) => {
		const p = POS[i % POS.length];
		return { x: p.x * w, y: p.y * h };
	});

	return (
		<View style={styles.container}>
			<View style={StyleSheet.absoluteFill} pointerEvents="box-none">
				{pts.slice(1).map((p, i) => (
					<Link
						key={`link-${items[i].key}`}
						x1={pts[i].x}
						y1={pts[i].y}
						x2={p.x}
						y2={p.y}
					/>
				))}
				{items.map((it, i) => (
					<Star
						key={it.key}
						item={it}
						x={pts[i].x}
						y={pts[i].y}
						delay={i * 160}
					/>
				))}
			</View>
			<View style={styles.head} pointerEvents="box-none">
				<FloatingMascot name={name} pixelSize={6} onTap={onMascotTap} />
				<QuipTerminal name={name} />
			</View>
			<Text style={styles.hint}>tap a star to warp</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, alignItems: "center" },
	head: { alignItems: "center", gap: 14, marginTop: 48 },
	link: {
		position: "absolute",
		height: 1,
		backgroundColor: colors.borderStrong,
		opacity: 0.45,
	},
	starSlot: {
		position: "absolute",
		width: 88,
		alignItems: "center",
	},
	star: { alignItems: "center", gap: 4 },
	starGlyph: { fontFamily: mono, fontSize: 22, fontWeight: "700" },
	label: {
		color: colors.accent2,
		fontFamily: mono,
		fontSize: 9,
		fontWeight: "700",
		letterSpacing: 0.5,
		textTransform: "uppercase",
	},
	dangerText: { color: colors.accent3 },
	hint: {
		position: "absolute",
		bottom: 16,
		color: colors.muted,
		fontFamily: mono,
		fontSize: 10,
		letterSpacing: 1,
		textTransform: "uppercase",
		opacity: 0.7,
	},
});
