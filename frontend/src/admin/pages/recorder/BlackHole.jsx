import { useEffect, useRef } from "react";

// Gargantua-style pixel black hole (the Interstellar look), drawn on a chunky
// pixel grid. Anatomy, back to front:
//
//   1. lower lensed arc  — the disk's far side bent UNDER the shadow (faint,
//                          heavily compressed secondary image)
//   2. upper lensed arc  — the far side bent OVER the shadow (the iconic halo)
//   3. the shadow        — pure black event-horizon silhouette
//   4. photon ring       — thin white-hot ring hugging the shadow edge
//   5. front band        — the near side of the thin disk, seen almost edge-on,
//                          crossing in front of the shadow
//
// Plus Doppler beaming: the side of the disk orbiting toward the camera (left)
// renders brighter and hotter than the receding side — just like the movie.
//
// It IS the record button. While recording it spins faster and flares with the
// mic level (read from `levelRef`, written by the waveform analyser loop).

const SIZE = 380; // logical canvas size (px)
const PX = 4; // pixel-art cell — everything snaps to this grid
const CENTER = SIZE / 2;
const SHADOW_R = 54; // event-horizon silhouette radius
const RING_R = SHADOW_R + PX; // photon ring radius
const DISK_IN = RING_R + 8; // inner edge of the accretion disk
const DISK_OUT = CENTER - 14; // outer edge
const TILT = 0.16; // how edge-on the front band is (smaller = flatter)
const ARC_SPREAD = 1.25; // radians the upper lensed arc spans each side of top
const PARTICLES = 620;
const BEAM = 0.55; // Doppler beaming strength (0..1)

// Heat palette, inner (hottest) → outer. Beaming shifts a step hotter.
const HEAT = ["#ffffff", "#fff3c4", "#f7c948", "#ffa53d", "#ff7a45", "#c4513a"];

// Deterministic PRNG so the disk looks the same every mount.
const makeRand = (seed) => {
	let s = seed;
	return () => {
		s = (s * 9301 + 49297) % 233280;
		return s / 233280;
	};
};

export default function BlackHole({ state = "idle", levelRef, onPress }) {
	const canvasRef = useRef(null);
	const stateRef = useRef(state);
	stateRef.current = state;

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		const dpr = window.devicePixelRatio || 1;
		canvas.width = SIZE * dpr;
		canvas.height = SIZE * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// Build the disk. Radius is biased toward the inner edge (denser, hotter
		// there); each particle keeps a little vertical jitter so the thin band
		// has body instead of being a 1-px line.
		const rand = makeRand(1414);
		const span = DISK_OUT - DISK_IN;
		const particles = [];
		for (let i = 0; i < PARTICLES; i++) {
			const r = DISK_IN + span * rand() ** 2;
			const n = (r - DISK_IN) / span; // 0 inner → 1 outer
			particles.push({
				r,
				n,
				angle: rand() * Math.PI * 2,
				// Keplerian: inner orbits much faster.
				speed: 0.85 * (DISK_IN / r) ** 1.5,
				jz: (rand() - 0.5) * (3 + n * 7),
				twinkle: rand() * Math.PI * 2,
				heat: Math.min(HEAT.length - 1, Math.floor(n * HEAT.length)),
			});
		}

		// The static shadow silhouette, rendered once to an offscreen layer.
		const shadow = document.createElement("canvas");
		shadow.width = SIZE * dpr;
		shadow.height = SIZE * dpr;
		const sctx = shadow.getContext("2d");
		sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		sctx.fillStyle = "#000";
		for (let y = -SHADOW_R; y <= SHADOW_R; y += PX) {
			for (let x = -SHADOW_R; x <= SHADOW_R; x += PX) {
				if (x * x + y * y <= SHADOW_R * SHADOW_R) {
					sctx.fillRect(
						Math.floor((CENTER + x) / PX) * PX,
						Math.floor((CENTER + y) / PX) * PX,
						PX,
						PX,
					);
				}
			}
		}

		const snap = (v) => Math.floor(v / PX) * PX;
		const cell = (x, y, color, alpha) => {
			ctx.globalAlpha = Math.min(1, alpha);
			ctx.fillStyle = color;
			ctx.fillRect(snap(x), snap(y), PX, PX);
		};

		let raf = 0;
		let last = performance.now();
		let t = 0;

		const draw = (now) => {
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			const st = stateRef.current;
			const level = Math.min(1, levelRef?.current ?? 0);
			const speedMul =
				st === "recording" ? 1.9 + level * 2.5 : st === "summarising" ? 0.4 : 1;
			const glow = st === "recording" ? 1 + level * 0.8 : 1;
			t += dt;
			ctx.clearRect(0, 0, SIZE, SIZE);

			// Collect this frame's cells per layer, then paint in depth order.
			const lower = [];
			const upper = [];
			const front = [];

			for (const p of particles) {
				p.angle += p.speed * speedMul * dt;
				const sin = Math.sin(p.angle);
				const cos = Math.cos(p.angle);
				const tw = 0.7 + 0.3 * Math.sin(t * 3 + p.twinkle);

				// Doppler beaming: the approaching (left) side is brighter and a
				// step hotter; the receding (right) side dims and cools.
				const approach = Math.max(0, -sin);
				const recede = Math.max(0, sin);
				const bright =
					tw * (0.55 + BEAM * approach) * (1 - 0.35 * recede) * glow;
				const heat = approach > 0.6 ? Math.max(0, p.heat - 1) : p.heat;
				const color = HEAT[heat];

				if (cos >= 0) {
					// Near side: the thin band crossing in front of the shadow.
					front.push({
						x: CENTER + sin * p.r,
						y: CENTER + cos * p.r * TILT + p.jz * 0.6,
						color,
						alpha: bright,
					});
				} else {
					// Far side: light bent around the hole. Primary image arcs over
					// the top (radially compressed toward the photon ring)…
					const psi = -Math.PI / 2 + sin * ARC_SPREAD;
					const R = RING_R + 4 + (p.r - DISK_IN) * 0.38 + p.jz * 0.4;
					upper.push({
						x: CENTER + Math.cos(psi) * R,
						y: CENTER + Math.sin(psi) * R,
						color,
						alpha: bright * 0.9,
					});
					// …and a fainter, tighter secondary image mirrors under it.
					const psi2 = Math.PI / 2 - sin * 1.0;
					const R2 = RING_R + 2 + (p.r - DISK_IN) * 0.16;
					lower.push({
						x: CENTER + Math.cos(psi2) * R2,
						y: CENTER + Math.sin(psi2) * R2,
						color,
						alpha: bright * 0.38,
					});
				}
			}

			for (const c of lower) cell(c.x, c.y, c.color, c.alpha);
			for (const c of upper) cell(c.x, c.y, c.color, c.alpha);

			// The shadow swallows whatever fell behind it.
			ctx.globalAlpha = 1;
			ctx.drawImage(shadow, 0, 0, SIZE, SIZE);

			// Photon ring: thin, white-hot, flaring with state + mic.
			const flare =
				st === "recording"
					? 0.65 + 0.35 * Math.min(1, level * 2 + 0.2 * Math.sin(t * 6))
					: st === "summarising"
						? 0.4 + 0.25 * Math.sin(t * 2.5)
						: 0.55 + 0.12 * Math.sin(t * 1.3);
			const ringColor = st === "recording" ? "#ffb09c" : "#fff3c4";
			for (let a = 0; a < Math.PI * 2; a += 0.04) {
				cell(
					CENTER + Math.cos(a) * RING_R,
					CENTER + Math.sin(a) * RING_R,
					ringColor,
					flare,
				);
			}

			// The near side of the disk passes in front of everything.
			for (const c of front) cell(c.x, c.y, c.color, c.alpha);

			ctx.globalAlpha = 1;
			raf = requestAnimationFrame(draw);
		};

		raf = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(raf);
	}, [levelRef]);

	return (
		<button
			type="button"
			className={`recorder-hole recorder-hole--${state}`}
			onClick={onPress}
			aria-label={state === "recording" ? "Stop recording" : "Start recording"}
		>
			<canvas
				ref={canvasRef}
				style={{ width: SIZE, height: SIZE }}
				className="recorder-hole-canvas"
			/>
		</button>
	);
}
