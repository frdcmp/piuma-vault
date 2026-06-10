import "./FtreeScene.css";

// Decorative pixel-art landscape that fills the empty space below the notes
// tree. Pure SVG on a fixed pixel grid (crispEdges + image-rendering:pixelated
// keep it sharp at any width). Static and pointer-transparent — purely cosmetic.

const COLS = 64;
const ROWS = 22;

// Deterministic rolling-hill profiles (top y per column; smaller y = taller).
const backTop = Array.from({ length: COLS }, (_, x) =>
	Math.round(11 + 2.5 * Math.sin(x / 9) + 1.5 * Math.sin(x / 3.5 + 1)),
);
const frontTop = Array.from({ length: COLS }, (_, x) =>
	Math.round(15 + 2 * Math.sin(x / 6 + 2) + Math.sin(x / 2.5)),
);

// Build a stepped polygon (one flat step per column) from a top-edge array.
function hillPath(top, offset = 0) {
	let d = `M0 ${ROWS}`;
	for (let x = 0; x < COLS; x++) {
		const y = top[x] + offset;
		d += ` L${x} ${y} L${x + 1} ${y}`;
	}
	return `${d} L${COLS} ${ROWS} Z`;
}

// Tiny pine sitting with its base at the given column's hill top.
function Pine({ cx }) {
	const base = frontTop[cx];
	return (
		<g>
			<rect x={cx} y={base - 1} width={1} height={1} fill="#23252b" />
			<rect x={cx - 2} y={base - 2} width={5} height={1} fill="#282c33" />
			<rect x={cx - 1} y={base - 3} width={3} height={1} fill="#282c33" />
			<rect x={cx} y={base - 4} width={1} height={1} fill="#30343d" />
		</g>
	);
}

// Fixed star field — {x, y, delay} so the twinkle is staggered, not synced.
const STARS = [
	{ x: 6, y: 3, d: 0 },
	{ x: 13, y: 6, d: 1.4 },
	{ x: 21, y: 2, d: 0.7 },
	{ x: 30, y: 5, d: 2.1 },
	{ x: 38, y: 3, d: 0.3 },
	{ x: 45, y: 7, d: 1.8 },
	{ x: 57, y: 5, d: 1.1 },
	{ x: 61, y: 2, d: 2.4 },
];

export default function FtreeScene() {
	return (
		<div className="ftree-scene" aria-hidden="true">
			<svg
				viewBox={`0 0 ${COLS} ${ROWS}`}
				preserveAspectRatio="xMidYMax slice"
				shapeRendering="crispEdges"
				role="presentation"
			>
				{/* Moon */}
				<g className="ftree-moon">
					<rect x={50} y={3} width={3} height={1} fill="#9a8340" />
					<rect x={49} y={4} width={5} height={1} fill="#9a8340" />
					<rect x={49} y={5} width={5} height={1} fill="#9a8340" />
					<rect x={50} y={6} width={3} height={1} fill="#9a8340" />
				</g>

				{/* Stars */}
				{STARS.map((s) => (
					<rect
						key={`${s.x}-${s.y}`}
						className="ftree-star"
						x={s.x}
						y={s.y}
						width={1}
						height={1}
						fill="#5b6373"
						style={{ animationDelay: `${s.d}s` }}
					/>
				))}

				{/* Distant hills */}
				<path d={hillPath(backTop)} fill="#21242b" />

				{/* Foreground hill: grass cap (muted) over body (dark) */}
				<path d={hillPath(frontTop)} fill="#2b2f37" />
				<path d={hillPath(frontTop, 1)} fill="#1d2027" />

				{/* A couple of pines */}
				<Pine cx={16} />
				<Pine cx={43} />
			</svg>
		</div>
	);
}
