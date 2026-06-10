import React, { useEffect, useRef } from "react";
import "./Starfield.css";

// Seconds for a star of each size to travel one full screen height. Smaller
// (distant) stars drift slower than bigger (closer) ones → parallax depth.
const DRIFT_SEC = { 1: 95, 2: 62, 3: 40 };

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

// Animated pixel starfield drawn on a canvas (one rAF loop, no per-star DOM
// nodes). Sizes itself to its container and drifts the stars downward, wrapping
// seamlessly. Purely decorative — sits behind the empty-state content.
export default function Starfield() {
	const canvasRef = useRef(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");

		const cs = getComputedStyle(canvas);
		const accent = cs.getPropertyValue("--accent").trim() || "#f7c948";
		const textColor = cs.getPropertyValue("--text").trim() || "#d6dbe5";

		let stars = [];
		let width = 0;
		let height = 0;
		let moonX = 0;
		let moonY = 0;
		let raf = 0;
		let last = performance.now();

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
			const count = Math.max(50, Math.floor((width * height) / 9000));
			stars = [];
			for (let i = 0; i < count; i++) {
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
			moonX = Math.floor(width * 0.78);
			moonY = Math.floor(height * 0.18);
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
			ctx.clearRect(0, 0, width, height);
			for (const st of stars) {
				st.y += st.speed * dt;
				if (st.y > height) st.y -= height;
				ctx.globalAlpha = st.bright ? 0.9 : 0.5;
				ctx.fillStyle = st.bright ? accent : textColor;
				ctx.fillRect(Math.floor(st.x), Math.floor(st.y), st.size, st.size);
			}
			drawMoon();
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
