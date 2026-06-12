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

// ───────────────────────── Deep-sky mix ─────────────────────────
// How many deep-sky objects appear, expressed as a fraction of the star
// count. Bump a value up to make that object more common, down to make it
// rarer, or 0 to remove it entirely. Mirrors the web starfield.
const OBJECT_RATIO = {
	nebula: 0.012,
	galaxy: 0.01,
	quasar: 0.008,
};
// Pixel size each deep-sky sprite cell is drawn at (bigger = larger object).
const OBJECT_PX = { nebula: 2, galaxy: 2, quasar: 2 };
// Deep-sky objects sit "furthest away" → drift slowest of all (full cycle ms).
const DEEP_DRIFT_MS = 140000;

// Pixel-art deep-sky sprites. Glyphs map to brightness (see ALPHA): a dim halo
// (o), mid body (*), bright body (#) and a brilliant core (@).
const NEBULA = [
	"..ooo.....",
	".o**#*o.o.",
	"o*###**oo.",
	".o*###**o.",
	"..oo**ooo.",
	"....ooo...",
];
const GALAXY = [
	"...ooo...",
	".oo**o...",
	"oo*##*o..",
	".o*#@#*o.",
	"..o*##*oo",
	"...o**oo.",
	"...ooo...",
];
const QUASAR = [
	"...o...",
	"...*...",
	"...#...",
	".o*@*o.",
	"...#...",
	"...*...",
	"...o...",
];

const ALPHA = { o: 0.28, "*": 0.55, "#": 0.85, "@": 1 };
const SPRITES = { nebula: NEBULA, galaxy: GALAXY, quasar: QUASAR };
// Per-object tints (mirror the web fallbacks).
const OBJECT_COLORS = {
	nebula: "#b06ab3",
	galaxy: "#8fb7ff",
	quasar: "#7fe7ff",
};

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

// A single deep-sky object (nebula / galaxy / quasar) drawn as a pixel grid,
// each cell tinted at its glyph brightness. Quasars pulse (they're variable by
// nature); the rest hold a steady glow.
function DeepSkySprite({ ob, pulse }) {
	const sprite = SPRITES[ob.type];
	const color = OBJECT_COLORS[ob.type];
	const grid = sprite.map((row, r) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: static pixel grid
		<View key={r} style={{ flexDirection: "row" }}>
			{row.split("").map((c, i) => {
				const a = ALPHA[c] || 0;
				return (
					<View
						// biome-ignore lint/suspicious/noArrayIndexKey: static pixel grid
						key={i}
						style={{
							width: ob.scale,
							height: ob.scale,
							backgroundColor: a ? color : "transparent",
							opacity: a,
						}}
					/>
				);
			})}
		</View>
	));
	const base = { position: "absolute", left: ob.x, top: ob.y };
	if (ob.type === "quasar") {
		const opacity = pulse.interpolate({
			inputRange: [0, 1],
			outputRange: [0.7, 1],
		});
		return <Animated.View style={[base, { opacity }]}>{grid}</Animated.View>;
	}
	return <View style={[base, { opacity: 0.85 }]}>{grid}</View>;
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
	const { layers, objects, moon } = useMemo(() => {
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
		// Deep-sky objects: count is a ratio of the star count, per type.
		const deepSky = [];
		for (const type of Object.keys(SPRITES)) {
			const n = Math.round(count * (OBJECT_RATIO[type] || 0));
			for (let i = 0; i < n; i++) {
				deepSky.push({
					type,
					x: Math.floor(rand() * width),
					y: Math.floor(rand() * height),
					scale: OBJECT_PX[type] || 2,
				});
			}
		}
		// Place moon in the upper-right quadrant, well away from the centred dog.
		const moonPos = {
			x: Math.floor(width * 0.78),
			y: Math.floor(height * 0.18),
		};
		return { layers: buckets, objects: deepSky, moon: moonPos };
	}, [width, height]);

	// One drift driver per depth layer. Created once; restarted by the effect.
	const drift = useRef(DEPTHS.map(() => new Animated.Value(0))).current;
	// Slowest drift for the deep-sky layer, plus a pulse driver for quasars.
	const deepDrift = useRef(new Animated.Value(0)).current;
	const pulse = useRef(new Animated.Value(0)).current;

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
		deepDrift.setValue(0);
		const deepLoop = Animated.loop(
			Animated.timing(deepDrift, {
				toValue: 1,
				duration: DEEP_DRIFT_MS,
				easing: Easing.linear,
				useNativeDriver: true,
			}),
		);
		deepLoop.start();
		loops.push(deepLoop);
		pulse.setValue(0);
		const pulseLoop = Animated.loop(
			Animated.sequence([
				Animated.timing(pulse, {
					toValue: 1,
					duration: 900,
					easing: Easing.inOut(Easing.sin),
					useNativeDriver: true,
				}),
				Animated.timing(pulse, {
					toValue: 0,
					duration: 900,
					easing: Easing.inOut(Easing.sin),
					useNativeDriver: true,
				}),
			]),
		);
		pulseLoop.start();
		loops.push(pulseLoop);
		return () => {
			for (const l of loops) l.stop();
		};
	}, [drift, deepDrift, pulse]);

	return (
		<View style={StyleSheet.absoluteFill} pointerEvents="none">
			{/* Deep-sky layer sits furthest back, drifting slowest, so the brighter
			    stars pass in front of it. Two stacked copies make the wrap seamless. */}
			{objects.length > 0 && (
				<Animated.View
					style={[
						StyleSheet.absoluteFill,
						{
							transform: [
								{
									translateY: deepDrift.interpolate({
										inputRange: [0, 1],
										outputRange: [0, height],
									}),
								},
							],
						},
					]}
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
							{objects.map((ob, idx) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: stable object list
								<DeepSkySprite key={idx} ob={ob} pulse={pulse} />
							))}
						</View>
					))}
				</Animated.View>
			)}
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
