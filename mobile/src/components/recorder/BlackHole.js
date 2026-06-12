import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import { colors } from "../../utils/theme";

// The black hole IS the record button — a tilted, spinning accretion disk
// around a dark event horizon, reacting to the live mic level. Native Animated
// port of the web BlackHole (canvas). States: idle | connecting | recording |
// finishing.
//
// To START you PRESS AND HOLD the void for 3s: it "powers up" (a ring of nodes
// lights around the rim, the glow swells, the disk spins up) and ignites into
// recording. Releasing early aborts the charge. While recording, a single tap
// stops.
//
// `levelRef` is a ref the recorder writes the RMS level (0..1) into each PCM
// chunk; we sample it on a timer into an Animated.Value so the glow + ejecta
// breathe with the audio without re-rendering React on every frame.

const EJECTA = 10; // matter flung off the disk while recording
const HOLD_MS = 3000; // press-and-hold duration to ignite
const CHARGE_NODES = 16; // rim nodes that light up as you charge

export default function BlackHole({
	state = "idle",
	levelRef,
	size = 240,
	onStart,
	onStop,
	onChargingChange,
}) {
	const recording = state === "recording";
	const connecting = state === "connecting";
	const finishing = state === "finishing";

	// Which hold is in progress: null | "start" (ignite) | "stop" (collapse).
	const [chargeMode, setChargeMode] = useState(null);
	const charging = chargeMode !== null;
	// Color the charge ring + glow by intent: amber to ignite, red to stop.
	const chargeColor = chargeMode === "stop" ? colors.accent3 : colors.accent;

	// Hot palette: amber idle, brightening toward white-hot while charging,
	// blue while connecting, red while recording.
	const hot = recording ? colors.accent3 : connecting ? colors.accent4 : colors.accent;

	// Drivers.
	const spin = useRef(new Animated.Value(0)).current;
	const counterSpin = useRef(new Animated.Value(0)).current;
	const level = useRef(new Animated.Value(0)).current;
	const idlePulse = useRef(new Animated.Value(0)).current;
	const charge = useRef(new Animated.Value(0)).current; // 0..1 hold progress
	const chargeAnimRef = useRef(null);

	// Continuous rotation — spins up while charging, fast while recording.
	useEffect(() => {
		const dur = charging ? 1300 : recording ? 2600 : connecting ? 4200 : 9000;
		const mk = (val, reverse) => {
			val.setValue(reverse ? 1 : 0);
			const loop = Animated.loop(
				Animated.timing(val, {
					toValue: reverse ? 0 : 1,
					duration: dur * (reverse ? 1.6 : 1),
					easing: Easing.linear,
					useNativeDriver: true,
				}),
			);
			loop.start();
			return loop;
		};
		const a = mk(spin, false);
		const b = mk(counterSpin, true);
		return () => {
			a.stop();
			b.stop();
		};
	}, [spin, counterSpin, recording, connecting, charging]);

	// Idle breathing so the void is never fully static.
	useEffect(() => {
		idlePulse.setValue(0);
		const loop = Animated.loop(
			Animated.sequence([
				Animated.timing(idlePulse, {
					toValue: 1,
					duration: 2200,
					easing: Easing.inOut(Easing.sin),
					useNativeDriver: true,
				}),
				Animated.timing(idlePulse, {
					toValue: 0,
					duration: 2200,
					easing: Easing.inOut(Easing.sin),
					useNativeDriver: true,
				}),
			]),
		);
		loop.start();
		return () => loop.stop();
	}, [idlePulse]);

	// Sample the live level into an Animated.Value (~16fps, smoothed).
	useEffect(() => {
		if (!recording) {
			Animated.timing(level, {
				toValue: 0,
				duration: 240,
				useNativeDriver: true,
			}).start();
			return;
		}
		const id = setInterval(() => {
			Animated.timing(level, {
				toValue: levelRef?.current ?? 0,
				duration: 80,
				useNativeDriver: true,
			}).start();
		}, 60);
		return () => clearInterval(id);
	}, [recording, level, levelRef]);

	// ── Press-and-hold to ignite (idle) / collapse (recording) ───────────────
	const beginCharge = useCallback(
		(mode) => {
			charge.setValue(0);
			setChargeMode(mode);
			onChargingChange?.(mode);
			const anim = Animated.timing(charge, {
				toValue: 1,
				duration: HOLD_MS,
				easing: Easing.inOut(Easing.quad),
				useNativeDriver: true,
			});
			chargeAnimRef.current = anim;
			anim.start(({ finished }) => {
				chargeAnimRef.current = null;
				if (finished) {
					// Held the full duration → fire the action for this mode.
					setChargeMode(null);
					onChargingChange?.(null);
					charge.setValue(0);
					if (mode === "stop") onStop?.();
					else onStart?.();
				}
			});
		},
		[charge, onStart, onStop, onChargingChange],
	);

	const cancelCharge = useCallback(() => {
		if (chargeAnimRef.current) {
			chargeAnimRef.current.stop(); // fires callback with finished:false → no-op
			chargeAnimRef.current = null;
		}
		setChargeMode(null);
		onChargingChange?.(null);
		Animated.timing(charge, {
			toValue: 0,
			duration: 220,
			useNativeDriver: true,
		}).start();
	}, [charge, onChargingChange]);

	const onPressIn = useCallback(() => {
		if (state === "idle") beginCharge("start");
		else if (state === "recording") beginCharge("stop");
	}, [state, beginCharge]);
	const onPressOut = useCallback(() => {
		if (state === "idle" || state === "recording") cancelCharge();
	}, [state, cancelCharge]);

	const rotate = spin.interpolate({
		inputRange: [0, 1],
		outputRange: ["0deg", "360deg"],
	});
	const counterRotate = counterSpin.interpolate({
		inputRange: [0, 1],
		outputRange: ["0deg", "360deg"],
	});

	// Glow: swells with the charge while powering up, with audio while recording,
	// otherwise breathes gently.
	const glowScale = charging
		? charge.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.7] })
		: recording
			? level.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] })
			: idlePulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.06] });
	const glowOpacity = charging
		? charge.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.7] })
		: recording
			? level.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.6] })
			: finishing
				? 0.1
				: idlePulse.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.26] });

	const horizon = size * 0.46;
	const diskBorder = Math.max(4, Math.round(size * 0.05));

	// Ejecta endpoints around the disk plane (computed once).
	const ejecta = useMemo(
		() =>
			Array.from({ length: EJECTA }, (_, i) => {
				const a = (i / EJECTA) * Math.PI * 2;
				return { a, cos: Math.cos(a), sin: Math.sin(a) * 0.42, key: i };
			}),
		[],
	);

	// Charge-ring node positions around the rim (full circle, not tilted).
	const nodes = useMemo(() => {
		const r = size * 0.5;
		return Array.from({ length: CHARGE_NODES }, (_, i) => {
			const a = (i / CHARGE_NODES) * Math.PI * 2 - Math.PI / 2; // start at top
			return {
				key: i,
				x: Math.cos(a) * r,
				y: Math.sin(a) * r,
				at: i / CHARGE_NODES,
			};
		});
	}, [size]);

	return (
		<Pressable
			onPressIn={onPressIn}
			onPressOut={onPressOut}
			delayLongPress={HOLD_MS + 500}
			hitSlop={12}
			style={{ width: size, height: size }}
		>
			<View style={styles.center}>
				{/* Outer glow halo */}
				<Animated.View
					style={[
						styles.fill,
						styles.center,
						{ transform: [{ scale: glowScale }], opacity: glowOpacity },
					]}
				>
					<View
						style={{
							width: size * 0.95,
							height: size * 0.95,
							borderRadius: size,
							backgroundColor: charging ? chargeColor : hot,
						}}
					/>
				</Animated.View>

				{/* Charge ring — rim nodes light up sequentially as you hold */}
				{charging &&
					nodes.map((n) => {
						const op = charge.interpolate({
							inputRange: [Math.max(0, n.at - 0.05), n.at, 1],
							outputRange: [0.12, 1, 1],
							extrapolate: "clamp",
						});
						const sc = charge.interpolate({
							inputRange: [Math.max(0, n.at - 0.05), n.at, 1],
							outputRange: [0.6, 1.3, 1],
							extrapolate: "clamp",
						});
						return (
							<Animated.View
								key={n.key}
								style={{
									position: "absolute",
									width: 5,
									height: 5,
									backgroundColor: chargeColor,
									opacity: op,
									transform: [
										{ translateX: n.x },
										{ translateY: n.y },
										{ scale: sc },
									],
								}}
							/>
						);
					})}

				{/* Ejecta — matter flung along the disk plane while recording */}
				{recording &&
					ejecta.map((e) => {
						const dist = level.interpolate({
							inputRange: [0, 1],
							outputRange: [horizon * 0.6, size * 0.62],
						});
						const op = level.interpolate({
							inputRange: [0, 0.15, 1],
							outputRange: [0, 0.5, 0.95],
						});
						return (
							<Animated.View
								key={e.key}
								style={{
									position: "absolute",
									width: 4,
									height: 4,
									backgroundColor: e.key % 3 === 0 ? colors.accent : hot,
									opacity: op,
									transform: [
										{ translateX: Animated.multiply(dist, e.cos) },
										{ translateY: Animated.multiply(dist, e.sin) },
									],
								}}
							/>
						);
					})}

				{/* Accretion disk — tilted, spinning ring with a hot leading edge */}
				<Animated.View
					style={[
						styles.fill,
						styles.center,
						{ transform: [{ rotate }, { scaleY: 0.42 }] },
					]}
				>
					<View
						style={{
							width: size * 0.9,
							height: size * 0.9,
							borderRadius: size,
							borderWidth: diskBorder,
							borderTopColor: hot,
							borderRightColor: hot,
							borderBottomColor: "rgba(255,255,255,0.06)",
							borderLeftColor: "rgba(255,255,255,0.12)",
						}}
					/>
				</Animated.View>

				{/* Inner counter-rotating ring for depth */}
				<Animated.View
					style={[
						styles.fill,
						styles.center,
						{ transform: [{ rotate: counterRotate }, { scaleY: 0.42 }] },
					]}
				>
					<View
						style={{
							width: size * 0.66,
							height: size * 0.66,
							borderRadius: size,
							borderWidth: Math.max(2, diskBorder - 2),
							borderTopColor: colors.accent,
							borderRightColor: "rgba(255,255,255,0.05)",
							borderBottomColor: "rgba(255,255,255,0.05)",
							borderLeftColor: hot,
							opacity: 0.7,
						}}
					/>
				</Animated.View>

				{/* Photon ring — bright thin circle at the horizon edge, brightens
				    as the charge fills */}
				<Animated.View
					style={{
						position: "absolute",
						width: horizon + 8,
						height: horizon + 8,
						borderRadius: size,
						borderWidth: 2,
						borderColor: hot,
						opacity: charging
							? charge.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] })
							: 0.85,
					}}
				/>

				{/* Event horizon — the dark core. Collapses slightly as it charges,
				    as if drawing the energy inward before ignition. */}
				<Animated.View
					style={{
						position: "absolute",
						width: horizon,
						height: horizon,
						borderRadius: size,
						backgroundColor: "#05060a",
						transform: [
							{
								scale: charging
									? charge.interpolate({
											inputRange: [0, 1],
											outputRange: [1, 0.78],
										})
									: 1,
							},
						],
					}}
				/>
			</View>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	fill: { ...StyleSheet.absoluteFillObject },
	center: { alignItems: "center", justifyContent: "center" },
});
