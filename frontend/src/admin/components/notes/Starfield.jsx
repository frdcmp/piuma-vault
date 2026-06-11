import React, { useEffect, useRef } from "react";
import "./Starfield.css";

// ───────────────────────── Tunable mix ─────────────────────────
// One background star per this many px² (lower = denser star field).
const STAR_DENSITY = 9000;
// How many deep-sky objects appear, expressed as a fraction of the star
// count. Bump a value up to make that object more common, down to make it
// rarer, or 0 to remove it entirely.
const OBJECT_RATIO = {
	nebula: 0.012,
	galaxy: 0.01,
	quasar: 0.008,
};
// Pixel size each deep-sky sprite cell is drawn at (bigger = larger object).
const OBJECT_PX = { nebula: 2, galaxy: 2, quasar: 2 };
// Show the pixel moon in the top-right.
const SHOW_MOON = true;

// Seconds for a star of each size to travel one full screen height. Smaller
// (distant) stars drift slower than bigger (closer) ones → parallax depth.
const DRIFT_SEC = { 1: 95, 2: 62, 3: 40 };
// Deep-sky objects sit "furthest away" → drift slowest of all.
const DEEP_DRIFT_SEC = 140;

// Tiny pixel-art moon (mirrors the mobile starfield).
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

// Animated pixel starfield drawn on a canvas (one rAF loop, no per-star DOM
// nodes). Sizes itself to its container and drifts everything downward,
// wrapping seamlessly. Background stars provide parallax depth; rarer deep-sky
// objects (nebulas, galaxies, quasars) drift slowest. Purely decorative — sits
// behind the empty-state content.
export default function Starfield() {
	const canvasRef = useRef(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");

		const cs = getComputedStyle(canvas);
		const accent = cs.getPropertyValue("--accent").trim() || "#f7c948";
		const textColor = cs.getPropertyValue("--text").trim() || "#d6dbe5";
		// Optional per-object tints (fall back to pleasant defaults).
		const colors = {
			nebula: cs.getPropertyValue("--nebula").trim() || "#b06ab3",
			galaxy: cs.getPropertyValue("--galaxy").trim() || "#8fb7ff",
			quasar: cs.getPropertyValue("--quasar").trim() || "#7fe7ff",
		};

		let stars = [];
		let objects = [];
		let width = 0;
		let height = 0;
		let moonX = 0;
		let moonY = 0;
		let raf = 0;
		let last = performance.now();
		let elapsed = 0;

		const build = () => {
			const rect = canvas.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			if (width === 0 || height === 0) return;
			const dpr = window.devicePixelRatio || 1;
			canvas.width = Math.floor(width * dpr);
			canvas.height = Math.floor(height * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

			// Deterministic PRNG so the pattern is stable across rebuilds.
			let s = 20251;
			const rand = () => {
				s = (s * 9301 + 49297) % 233280;
				return s / 233280;
			};
			const starCount = Math.max(
				50,
				Math.floor((width * height) / STAR_DENSITY),
			);
			stars = [];
			for (let i = 0; i < starCount; i++) {
				const r = rand();
				const size = r > 0.92 ? 3 : r > 0.65 ? 2 : 1;
				stars.push({
					x: rand() * width,
					y: rand() * height,
					size,
					bright: r > 0.85,
					speed: height / DRIFT_SEC[size],
				});
			}

			// Deep-sky objects: count is a ratio of the star count, per type.
			objects = [];
			for (const type of Object.keys(SPRITES)) {
				const n = Math.round(starCount * (OBJECT_RATIO[type] || 0));
				for (let i = 0; i < n; i++) {
					objects.push({
						type,
						x: rand() * width,
						y: rand() * height,
						scale: OBJECT_PX[type] || 2,
						speed: height / DEEP_DRIFT_SEC,
						phase: rand() * Math.PI * 2,
					});
				}
			}

			moonX = Math.floor(width * 0.78);
			moonY = Math.floor(height * 0.18);
		};

		const drawSprite = (sprite, x, y, scale, color, brightness) => {
			ctx.fillStyle = color;
			const px = Math.floor(x);
			const py = Math.floor(y);
			for (let r = 0; r < sprite.length; r++) {
				const row = sprite[r];
				for (let c = 0; c < row.length; c++) {
					const a = ALPHA[row[c]];
					if (!a) continue;
					ctx.globalAlpha = a * brightness;
					ctx.fillRect(px + c * scale, py + r * scale, scale, scale);
				}
			}
		};

		const drawMoon = () => {
			ctx.globalAlpha = 1;
			ctx.fillStyle = "#f7e9b0";
			for (let r = 0; r < MOON.length; r++) {
				const row = MOON[r];
				for (let c = 0; c < row.length; c++) {
					if (row[c] === "#") {
						ctx.fillRect(moonX + c * 3, moonY + r * 3, 3, 3);
					}
				}
			}
		};

		const draw = (now) => {
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			elapsed += dt;
			ctx.clearRect(0, 0, width, height);

			// Deep-sky objects first so the brighter stars sit on top of them.
			for (const ob of objects) {
				ob.y += ob.speed * dt;
				if (ob.y > height) ob.y -= height;
				// Quasars pulse (they're variable by nature); the rest are steady.
				const brightness =
					ob.type === "quasar"
						? 0.7 + 0.3 * Math.sin(elapsed * 2 + ob.phase)
						: 0.85;
				drawSprite(
					SPRITES[ob.type],
					ob.x,
					ob.y,
					ob.scale,
					colors[ob.type],
					brightness,
				);
			}

			for (const st of stars) {
				st.y += st.speed * dt;
				if (st.y > height) st.y -= height;
				ctx.globalAlpha = st.bright ? 0.9 : 0.5;
				ctx.fillStyle = st.bright ? accent : textColor;
				ctx.fillRect(Math.floor(st.x), Math.floor(st.y), st.size, st.size);
			}

			if (SHOW_MOON) drawMoon();
			ctx.globalAlpha = 1;
			raf = requestAnimationFrame(draw);
		};

		build();
		raf = requestAnimationFrame(draw);

		const ro = new ResizeObserver(build);
		ro.observe(canvas);

		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
		};
	}, []);

	return <canvas ref={canvasRef} className="piuma-starfield" />;
}
