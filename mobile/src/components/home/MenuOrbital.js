import { useEffect, useRef } from "react";
import {
	Animated,
	Easing,
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

const ITEM = 72; // hit-box size for each orbiting planet

// Bubu is the sun; destinations orbit as planets on a fixed ring. The ring
// drifts slowly on its own and can be flung by dragging. Each planet
// counter-rotates so its label always stays upright.
export default function MenuOrbital({ items, name, dims, onMascotTap }) {
	const size = Math.min(
		(dims?.width || 320) - 16,
		(dims?.height || 560) * 0.6,
		360,
	);
	const radius = size / 2 - ITEM / 2;
	const center = size / 2;

	// auto: continuous ambient drift (0..1 → full turn). manual: drag offset in
	// "turns" (1 = 360°). Container applies both; planets apply the inverse of
	// both to stay upright.
	const auto = useRef(new Animated.Value(0)).current;
	const manual = useRef(new Animated.Value(0)).current;
	const manualVal = useRef(0);

	useEffect(() => {
		const id = manual.addListener(({ value }) => {
			manualVal.current = value;
		});
		const loop = Animated.loop(
			Animated.timing(auto, {
				toValue: 1,
				duration: 60000,
				easing: Easing.linear,
				useNativeDriver: true,
			}),
		);
		loop.start();
		return () => {
			loop.stop();
			manual.removeListener(id);
		};
	}, [auto, manual]);

	const pan = useRef(
		PanResponder.create({
			// Only claim the gesture once it's clearly a drag, so taps still reach
			// the planets underneath.
			onMoveShouldSetPanResponder: (_e, g) =>
				Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
			onPanResponderGrant: () => {
				manual.stopAnimation();
			},
			onPanResponderMove: (_e, g) => {
				// ~1 full turn per 2x ring width of drag.
				manual.setValue(manualVal.current + g.dx / (size * 2));
			},
			onPanResponderRelease: (_e, g) => {
				// Carry a little momentum, then settle.
				Animated.decay(manual, {
					velocity: g.vx / (size * 2),
					deceleration: 0.995,
					useNativeDriver: true,
				}).start();
			},
		}),
	).current;

	const autoSpin = auto.interpolate({
		inputRange: [0, 1],
		outputRange: ["0deg", "360deg"],
	});
	const autoSpinInv = auto.interpolate({
		inputRange: [0, 1],
		outputRange: ["0deg", "-360deg"],
	});
	const manualSpin = manual.interpolate({
		inputRange: [-1, 1],
		outputRange: ["-360deg", "360deg"],
	});
	const manualSpinInv = manual.interpolate({
		inputRange: [-1, 1],
		outputRange: ["360deg", "-360deg"],
	});

	return (
		<View style={styles.container}>
			<QuipTerminal name={name} />
			<View style={{ width: size, height: size }}>
				<Animated.View
					{...pan.panHandlers}
					style={[
						StyleSheet.absoluteFill,
						{ transform: [{ rotate: autoSpin }, { rotate: manualSpin }] },
					]}
				>
					{items.map((it, i) => {
						const a = (i / items.length) * 2 * Math.PI - Math.PI / 2;
						const left = center + radius * Math.cos(a) - ITEM / 2;
						const top = center + radius * Math.sin(a) - ITEM / 2;
						return (
							<View key={it.key} style={[styles.planetSlot, { left, top }]}>
								<Animated.View
									style={{
										transform: [
											{ rotate: autoSpinInv },
											{ rotate: manualSpinInv },
										],
									}}
								>
									<Pressable
										onPress={it.onPress}
										style={({ pressed }) => [
											styles.planet,
											pressed && styles.planetPressed,
										]}
									>
										<Text style={[styles.glyph, { color: toneColor(it.tone) }]}>
											{it.glyph}
										</Text>
										<Text
											style={[
												styles.label,
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
				<View style={styles.sun} pointerEvents="box-none">
					<FloatingMascot name={name} pixelSize={6} onTap={onMascotTap} />
				</View>
			</View>
			<Text style={styles.hint}>drag to spin · tap a planet</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		gap: 28,
	},
	planetSlot: {
		position: "absolute",
		width: ITEM,
		height: ITEM,
		alignItems: "center",
		justifyContent: "center",
	},
	planet: { alignItems: "center", gap: 4, padding: 4 },
	planetPressed: { opacity: 0.45 },
	sun: {
		...StyleSheet.absoluteFillObject,
		alignItems: "center",
		justifyContent: "center",
	},
	glyph: {
		fontFamily: mono,
		fontSize: 18,
		fontWeight: "700",
		textAlign: "center",
	},
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
		color: colors.muted,
		fontFamily: mono,
		fontSize: 10,
		letterSpacing: 1,
		textTransform: "uppercase",
		opacity: 0.7,
	},
});
