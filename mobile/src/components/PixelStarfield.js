import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { colors } from "../utils/theme";

// Deterministic PRNG so the star pattern is stable across re-renders
// (no jumping during animation) but still feels random.
function makeRand(seed) {
	let s = seed;
	return () => {
		s = (s * 9301 + 49297) % 233280;
		return s / 233280;
	};
}

// Tiny pixel-art moon in the upper area.
const MOON = [
	"..####..",
	".######.",
	"########",
	"########",
	"########",
	"########",
	".######.",
	"..####..",
];

function PixelMoon({ x, y, pixelSize = 3 }) {
	return (
		<View style={{ position: "absolute", left: x, top: y }}>
			{MOON.map((row, r) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static pixel grid
				<View key={r} style={{ flexDirection: "row" }}>
					{row.split("").map((c, i) => (
						<View
							// biome-ignore lint/suspicious/noArrayIndexKey: static pixel grid
							key={i}
							style={{
								width: pixelSize,
								height: pixelSize,
								backgroundColor: c === "#" ? "#f7e9b0" : "transparent",
							}}
						/>
					))}
				</View>
			))}
		</View>
	);
}

// Depth layers — keyed by star size. Smaller (distant) stars drift slower than
// bigger (closer) ones, which reads as parallax. Each value is a full vertical
// cycle in ms.
const DEPTHS = [1, 2, 3];
const DRIFT_MS = { 1: 95000, 2: 62000, 3: 40000 };

// Comets streak across occasionally. Tunables:
const COMET_SPEED = { min: 280, max: 460 }; // px/sec along their path
const COMET_TAIL = { min: 8, max: 16 }; // tail length in head-steps
const COMET_GAP_MS = { min: 6000, max: 16000 }; // delay between spawns

const randRange = (lo, hi) => lo + Math.random() * (hi - lo);

// A single comet: a bright head trailing a tapering wake, translated across the
// screen once, then it reports back so the parent can drop it.
function Comet({ comet, onDone }) {
	const t = useRef(new Animated.Value(0)).current;

	useEffect(() => {
		t.setValue(0);
		const anim = Animated.timing(t, {
			toValue: 1,
			duration: comet.duration,
			easing: Easing.linear,
			useNativeDriver: true,
		});
		anim.start(({ finished }) => {
			if (finished) onDone(comet.id);
		});
		return () => anim.stop();
	}, [comet, t, onDone]);

	const translateX = t.interpolate({
		inputRange: [0, 1],
		outputRange: [0, comet.ux * comet.dist],
	});
	const translateY = t.interpolate({
		inputRange: [0, 1],
		outputRange: [0, comet.uy * comet.dist],
	});

	const step = comet.size + 1;
	const head = comet.size + 1;

	return (
		<Animated.View
			style={{
				position: "absolute",
				left: comet.x,
				top: comet.y,
				transform: [{ translateX }, { translateY }],
			}}
		>
			{/* Tail squares sit behind the head, fading along the wake. */}
			{Array.from({ length: comet.tail }).map((_, i) => {
				const n = i + 1;
				return (
					<View
						key={n}
						style={{
							position: "absolute",
							left: -comet.ux * n * step,
							top: -comet.uy * n * step,
							width: comet.size,
							height: comet.size,
							backgroundColor: colors.text,
							opacity: (1 - n / (comet.tail + 1)) * 0.55,
						}}
					/>
				);
			})}
			{/* Bright head on top. */}
			<View
				style={{
					position: "absolute",
					width: head,
					height: head,
					backgroundColor: colors.accent,
				}}
			/>
		</Animated.View>
	);
}

// Mounts comets on a timer, entering from the top/left and flying down-right;
// each Comet removes itself when its run finishes.
function CometLayer({ width, height }) {
	const [comets, setComets] = useState([]);
	const idRef = useRef(0);

	useEffect(() => {
		let timer;
		let alive = true;

		const spawn = () => {
			if (!alive) return;
			const fromLeft = Math.random() < 0.5;
			const x = fromLeft ? -20 : Math.random() * width * 0.7;
			const y = fromLeft ? Math.random() * height * 0.5 : -20;
			const angle = randRange(Math.PI * 0.18, Math.PI * 0.32); // down-right
			const ux = Math.cos(angle);
			const uy = Math.sin(angle);
			const dist = width + height + 80; // guarantees a full off-screen exit
			const speed = randRange(COMET_SPEED.min, COMET_SPEED.max);
			const id = idRef.current++;
			setComets((prev) => [
				...prev,
				{
					id,
					x,
					y,
					ux,
					uy,
					dist,
					duration: (dist / speed) * 1000,
					tail: Math.round(randRange(COMET_TAIL.min, COMET_TAIL.max)),
					size: Math.random() > 0.6 ? 2 : 1,
				},
			]);
			timer = setTimeout(spawn, randRange(COMET_GAP_MS.min, COMET_GAP_MS.max));
		};

		timer = setTimeout(spawn, randRange(COMET_GAP_MS.min, COMET_GAP_MS.max));
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [width, height]);

	const remove = useRef((id) =>
		setComets((prev) => prev.filter((c) => c.id !== id)),
	).current;

	return (
		<>
			{comets.map((c) => (
				<Comet key={c.id} comet={c} onDone={remove} />
			))}
		</>
	);
}

function Star({ s }) {
	return (
		<View
			style={{
				position: "absolute",
				left: s.x,
				top: s.y,
				width: s.size,
				height: s.size,
				backgroundColor: s.bright ? colors.accent : colors.text,
				opacity: s.bright ? 0.9 : 0.5,
			}}
		/>
	);
}

export default function PixelStarfield({ width, height }) {
	const { layers, moon } = useMemo(() => {
		const rand = makeRand(20251);
		const buckets = { 1: [], 2: [], 3: [] };
		// Density scales with viewport area so a wide screen still feels starry.
		const count = Math.max(50, Math.floor((width * height) / 9000));
		for (let i = 0; i < count; i++) {
			const r = rand();
			const size = r > 0.92 ? 3 : r > 0.65 ? 2 : 1;
			buckets[size].push({
				x: Math.floor(rand() * width),
				y: Math.floor(rand() * height),
				size,
				bright: r > 0.85,
			});
		}
		// Place moon in the upper-right quadrant, well away from the centred dog.
		const moonPos = {
			x: Math.floor(width * 0.78),
			y: Math.floor(height * 0.18),
		};
		return { layers: buckets, moon: moonPos };
	}, [width, height]);

	// One drift driver per depth layer. Created once; restarted by the effect.
	const drift = useRef(DEPTHS.map(() => new Animated.Value(0))).current;

	useEffect(() => {
		const loops = drift.map((val, i) => {
			val.setValue(0);
			const loop = Animated.loop(
				Animated.timing(val, {
					toValue: 1,
					duration: DRIFT_MS[DEPTHS[i]],
					easing: Easing.linear,
					useNativeDriver: true,
				}),
			);
			loop.start();
			return loop;
		});
		return () => {
			for (const l of loops) l.stop();
		};
	}, [drift]);

	return (
		<View style={StyleSheet.absoluteFill} pointerEvents="none">
			{DEPTHS.map((depth, i) => {
				// 0 → height slide. Two stacked copies (one a full height above) make
				// the wrap seamless: at the end the upper copy sits exactly where the
				// lower one began, so the loop reset is invisible.
				const translateY = drift[i].interpolate({
					inputRange: [0, 1],
					outputRange: [0, height],
				});
				return (
					<Animated.View
						key={depth}
						style={[StyleSheet.absoluteFill, { transform: [{ translateY }] }]}
					>
						{[0, -height].map((offset) => (
							<View
								key={offset}
								style={{
									position: "absolute",
									left: 0,
									top: offset,
									width,
									height,
								}}
							>
								{layers[depth].map((s, idx) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: stable star list
									<Star key={idx} s={s} />
								))}
							</View>
						))}
					</Animated.View>
				);
			})}
			<CometLayer width={width} height={height} />
			<PixelMoon x={moon.x} y={moon.y} pixelSize={3} />
		</View>
	);
}
