import { useEffect, useRef, useState } from "react";
import {
	Animated,
	PanResponder,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { colors, mono } from "../../utils/theme";
import FloatingMascot from "./FloatingMascot";
import { toneColor } from "./menuItems";
import QuipTerminal from "./QuipTerminal";

const ITEM = 84;

// A press-and-rotate wheel anchored low on the screen (thumb-friendly). The
// item at the top notch is "selected" (highlighted); dragging spins the wheel
// and it snaps to the nearest detent on release. Tap any item to open it.
export default function MenuDial({ items, name, dims, onMascotTap }) {
	const n = items.length;
	const step = 360 / n; // degrees between detents
	const wheel = Math.min((dims?.width || 320) * 1.5, 540);
	const radius = wheel / 2 - ITEM / 2;
	const center = wheel / 2;

	// rot: wheel rotation in degrees. rotVal mirrors it for JS-side math.
	const rot = useRef(new Animated.Value(0)).current;
	const rotVal = useRef(0);
	const [topIndex, setTopIndex] = useState(0);

	useEffect(() => {
		const id = rot.addListener(({ value }) => {
			rotVal.current = value;
			// Index of the item currently nearest the top notch.
			const idx = ((Math.round(-value / step) % n) + n) % n;
			setTopIndex((prev) => (prev === idx ? prev : idx));
		});
		return () => rot.removeListener(id);
	}, [rot, n, step]);

	const pan = useRef(
		PanResponder.create({
			onMoveShouldSetPanResponder: (_e, g) =>
				Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
			onPanResponderGrant: () => rot.stopAnimation(),
			onPanResponderMove: (_e, g) => {
				rot.setValue(rotVal.current + g.dx * 0.5);
			},
			onPanResponderRelease: () => {
				const snapped = Math.round(rotVal.current / step) * step;
				Animated.spring(rot, {
					toValue: snapped,
					useNativeDriver: true,
					speed: 14,
					bounciness: 8,
				}).start();
			},
		}),
	).current;

	const spin = rot.interpolate({
		inputRange: [-360, 360],
		outputRange: ["-360deg", "360deg"],
	});
	const spinInv = rot.interpolate({
		inputRange: [-360, 360],
		outputRange: ["360deg", "-360deg"],
	});

	return (
		<View style={styles.container}>
			<View style={styles.head}>
				<FloatingMascot name={name} pixelSize={6} onTap={onMascotTap} />
				<QuipTerminal name={name} />
				<Text style={styles.selected}>{items[topIndex]?.label}</Text>
			</View>

			<View
				style={[
					styles.wheelWrap,
					{ width: wheel, height: wheel, bottom: -wheel * 0.6 },
				]}
				{...pan.panHandlers}
			>
				{/* Notch marker at the top of the wheel. */}
				<Text style={[styles.notch, { left: center - 8 }]}>▾</Text>
				<Animated.View
					style={[StyleSheet.absoluteFill, { transform: [{ rotate: spin }] }]}
				>
					{items.map((it, i) => {
						const a = (i / n) * 2 * Math.PI - Math.PI / 2;
						const left = center + radius * Math.cos(a) - ITEM / 2;
						const top = center + radius * Math.sin(a) - ITEM / 2;
						const active = i === topIndex;
						return (
							<View key={it.key} style={[styles.slot, { left, top }]}>
								<Animated.View style={{ transform: [{ rotate: spinInv }] }}>
									<Pressable
										onPress={it.onPress}
										style={({ pressed }) => [
											styles.item,
											active && styles.itemActive,
											pressed && styles.itemPressed,
										]}
									>
										<Text
											style={[
												styles.glyph,
												{ color: toneColor(it.tone) },
												active && styles.glyphActive,
											]}
										>
											{it.glyph}
										</Text>
										<Text
											style={[
												styles.label,
												active && styles.labelActive,
												it.tone === "danger" && styles.dangerText,
											]}
										>
											{it.label}
										</Text>
									</Pressable>
								</Animated.View>
							</View>
						);
					})}
				</Animated.View>
			</View>
			<Text style={styles.hint}>press & rotate · tap to open</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, alignItems: "center", justifyContent: "center" },
	head: {
		alignItems: "center",
		gap: 16,
		// Sit a little above true center so the block reads with the wheel below
		// rather than floating in the middle of the dead space.
		marginBottom: 96,
	},
	selected: {
		color: colors.accent,
		fontFamily: mono,
		fontSize: 15,
		fontWeight: "700",
		letterSpacing: 2,
		textTransform: "uppercase",
	},
	wheelWrap: {
		position: "absolute",
		alignItems: "center",
		justifyContent: "center",
	},
	notch: {
		position: "absolute",
		top: -2,
		color: colors.accent,
		fontFamily: mono,
		fontSize: 16,
		zIndex: 2,
	},
	slot: {
		position: "absolute",
		width: ITEM,
		height: ITEM,
		alignItems: "center",
		justifyContent: "center",
	},
	item: { alignItems: "center", gap: 4, padding: 6, opacity: 0.6 },
	itemActive: { opacity: 1 },
	itemPressed: { opacity: 0.4 },
	glyph: { fontFamily: mono, fontSize: 18, fontWeight: "700" },
	glyphActive: { fontSize: 24 },
	label: {
		color: colors.accent2,
		fontFamily: mono,
		fontSize: 9,
		fontWeight: "700",
		letterSpacing: 0.5,
		textTransform: "uppercase",
	},
	labelActive: { fontSize: 11 },
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
