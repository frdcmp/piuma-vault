import { useEffect, useRef } from "react";

// Pixel "Gargantua" — the Interstellar look, on a pixel grid. Two coupled
// structures frame a central black sphere:
//
//   • WINGS  — the accretion disk seen almost edge-on: a flat horizontal band
//              that flares out to the left and right, brightest near the sphere.
//              Its lower (near) half crosses in FRONT of the sphere; its upper
//              (far) half passes BEHIND it.
//   • HALO   — the gravitationally-lensed image of that same disk, bent up over
//              the TOP and down under the BOTTOM, forming a bright ring that
//              wraps the sphere vertically. Brightest at top/bottom, fading into
//              the wings at the sides.
//
//   + a thin white-hot photon ring hugging the shadow.
//
// Everything rotates (Keplerian: inner faster). It IS the record button — while
// recording it spins faster and flares with the mic level (`levelRef`).

const SIZE = 620;
const PX = 4;
const CENTER = SIZE / 2;
const SHADOW_R = 90; // event-horizon silhouette radius
const RING_R = SHADOW_R + 5; // photon ring radius
const WING_IN = RING_R + 10; // inner edge of the edge-on disk
const WING_OUT = CENTER - 4; // outer edge (flares to the canvas sides)
const WING_TILT = 0.12; // near edge-on (smaller = flatter)
const WING_N = 1100;
const HALO_R = RING_R + 9; // mean radius of the lensed vertical halo
const HALO_THICK = 20; // halo band thickness
const HALO_N = 380;
const BEAM = 0.22; // subtle Doppler brightening on the approaching side
const SHADOW_R2 = SHADOW_R * SHADOW_R;
// Only the thin central disk band is allowed to cross IN FRONT of the shadow;
// everything else inside the silhouette is clipped so the hole stays pure black.
const BAND_HALF = 14;
// Pool of matter the hole flings out along the disk plane while recording.
const EJECTA_N = 280;

// Heat palette, hottest → coolest.
const HEAT = ["#ffffff", "#fff3c4", "#f7c948", "#ffa53d", "#ff7a45", "#c4513a"];

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
	// Hover speeds the idle spin up; read through a ref so the draw loop sees it
	// without restarting.
	const hoverRef = useRef(false);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		const dpr = window.devicePixelRatio || 1;
		canvas.width = SIZE * dpr;
		canvas.height = SIZE * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		const rand = makeRand(2025);
		const wspan = WING_OUT - WING_IN;

		// Edge-on disk particles, density-biased toward the inner (hot) edge.
		const wings = [];
		for (let i = 0; i < WING_N; i++) {
			const r = WING_IN + wspan * rand() ** 1.7;
			const n = (r - WING_IN) / wspan;
			wings.push({
				r,
				n,
				angle: rand() * Math.PI * 2,
				speed: 0.8 * (WING_IN / r) ** 1.5, // Keplerian
				jz: (rand() - 0.5) * (2 + n * 9), // thickens outward into wisps
				twinkle: rand() * Math.PI * 2,
				heat: Math.min(HEAT.length - 1, Math.floor(n * (HEAT.length - 1))),
			});
		}

		// Halo particles orbit a near-circle just outside the photon ring.
		const halo = [];
		for (let i = 0; i < HALO_N; i++) {
			halo.push({
				angle: rand() * Math.PI * 2,
				rr: (rand() - 0.5) * HALO_THICK, // radial jitter → band thickness
				speed: 0.6 + rand() * 0.5,
				twinkle: rand() * Math.PI * 2,
				heat: rand() < 0.4 ? 0 : 1,
			});
		}

		// Ejecta pool — recycled particles the hole spews out while recording.
		// `life <= 0` means free to (re)spawn.
		const ejecta = Array.from({ length: EJECTA_N }, () => ({ life: 0 }));
		let spawnAcc = 0;

		// Pre-render the shadow silhouette once.
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
			ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
			ctx.fillStyle = color;
			ctx.fillRect(snap(x), snap(y), PX, PX);
		};
		// Is a point within the event-horizon silhouette? Used to keep stray
		// particles out of the hole's interior.
		const inShadow = (x, y) => {
			const dx = x - CENTER;
			const dy = y - CENTER;
			return dx * dx + dy * dy <= SHADOW_R2;
		};

		let raf = 0;
		let last = performance.now();
		let t = 0;

		const draw = (now) => {
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			const st = stateRef.current;
			const level = Math.min(1, levelRef?.current ?? 0);
			const connecting = st === "connecting";
			const recording = st === "recording";
			const speedMul = recording
				? 1.8 + level * 2.4
				: connecting
					? 1.25
					: st === "finishing"
						? 0.4
						: hoverRef.current
							? 0.85
							: 0.3;
			// Connecting: the disk dims as the hole "charges"; recording flares it
			// with the mic level.
			const glow = recording ? 1 + level * 0.7 : connecting ? 0.5 : 1;
			t += dt;
			ctx.clearRect(0, 0, SIZE, SIZE);

			// 1) Wings — split front/back so the sphere occludes the far half.
			const front = [];
			for (const p of wings) {
				p.angle += p.speed * speedMul * dt;
				const cos = Math.cos(p.angle);
				const sin = Math.sin(p.angle);
				const x = CENTER + cos * p.r;
				const y = CENTER + sin * p.r * WING_TILT + p.jz;
				const tw = 0.72 + 0.28 * Math.sin(t * 3 + p.twinkle);
				// Brightest near the sphere and at the edge-on sides; fade outward.
				const fade = (1 - 0.7 * p.n) * (0.5 + 0.5 * Math.abs(cos));
				const beam = 0.85 + BEAM * Math.max(0, -cos);
				const alpha = tw * fade * beam * glow;
				const e = { x, y, color: HEAT[p.heat], alpha };
				if (sin > 0)
					front.push(e); // lower/near half → in front
				else cell(x, y, e.color, e.alpha * 0.9); // upper/far half → behind
			}

			// 2) Shadow swallows the far half behind it.
			ctx.globalAlpha = 1;
			ctx.drawImage(shadow, 0, 0, SIZE, SIZE);

			// 3) Lensed halo ring — brightest at top & bottom, dim at the sides
			//    (where it blends into the wings). Wraps the sphere vertically.
			for (const h of halo) {
				h.angle += h.speed * speedMul * 0.5 * dt;
				const sin = Math.sin(h.angle);
				const cos = Math.cos(h.angle);
				const r = HALO_R + h.rr;
				const x = CENTER + cos * r;
				const y = CENTER + sin * r;
				const tw = 0.7 + 0.3 * Math.sin(t * 3 + h.twinkle);
				const vert = 0.25 + 0.75 * Math.abs(sin); // peak top/bottom
				cell(x, y, HEAT[h.heat], tw * vert * (0.9 * glow));
			}

			// 4) Photon ring. Connecting → a hot arc races around it like a loading
			//    spinner. Otherwise → the steady white-hot ring, throbbing harder
			//    while recording.
			if (connecting) {
				const head = (t * 3.4) % (Math.PI * 2);
				const arcLen = Math.PI * 0.7; // length of the bright sweep
				for (let a = 0; a < Math.PI * 2; a += 0.03) {
					let d = head - a;
					d = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
					const bright = d < arcLen ? 1 - d / arcLen : 0; // tail fades back
					cell(
						CENTER + Math.cos(a) * RING_R,
						CENTER + Math.sin(a) * RING_R,
						bright > 0.5 ? "#ffffff" : "#fff3c4",
						0.12 + bright * 0.95,
					);
				}
			} else {
				const flare = recording
					? 0.7 + 0.3 * Math.min(1, level * 2 + 0.2 * Math.sin(t * 6))
					: st === "finishing"
						? 0.4 + 0.25 * Math.sin(t * 2.5)
						: 0.6 + 0.12 * Math.sin(t * 1.3);
				const ringColor = recording ? "#ffd0c0" : "#fff3c4";
				for (let a = 0; a < Math.PI * 2; a += 0.03) {
					cell(
						CENTER + Math.cos(a) * RING_R,
						CENTER + Math.sin(a) * RING_R,
						ringColor,
						flare,
					);
				}
			}

			// 4b) Recording: shock rings pulse outward along the disk plane —
			//     stronger and faster with the mic level, so loud moments "boom".
			if (recording) {
				const span = WING_OUT - RING_R;
				for (let i = 0; i < 3; i++) {
					const p01 = (t * (0.5 + level * 0.9) + i / 3) % 1;
					const rr = RING_R + p01 * span;
					const a = (1 - p01) * (0.3 + level * 0.55);
					if (a <= 0.02) continue;
					for (let ang = 0; ang < Math.PI * 2; ang += 0.06) {
						const cos = Math.cos(ang);
						const x = CENTER + cos * rr;
						const y = CENTER + Math.sin(ang) * rr * WING_TILT;
						if (inShadow(x, y)) continue;
						cell(x, y, "#ffd0c0", a * (0.45 + 0.55 * Math.abs(cos)));
					}
				}
			}

			// 5) Near half of the wings, in front of everything. Inside the
			//    silhouette keep ONLY the thin central band crossing — clip the rest
			//    so the hole's interior stays pure black.
			for (const e of front) {
				if (inShadow(e.x, e.y) && Math.abs(e.y - CENTER) > BAND_HALF) continue;
				cell(e.x, e.y, e.color, e.alpha);
			}

			// 6) Recording: the hole flings matter out along the disk plane. Spawn
			//    rate + speed scale with the mic level, so it spews harder on louder
			//    input. Particles launch from outside the ring — never the interior.
			if (recording) {
				spawnAcc += dt * (50 + level * 320);
				while (spawnAcc >= 1) {
					spawnAcc -= 1;
					const p = ejecta.find((e) => e.life <= 0);
					if (!p) break;
					const side = rand() < 0.5 ? -1 : 1;
					const ang = (side < 0 ? Math.PI : 0) + (rand() - 0.5) * 0.6;
					const sp = 70 + rand() * 140 + level * 260;
					p.x = CENTER + Math.cos(ang) * WING_IN;
					p.y = CENTER + Math.sin(ang) * WING_IN * WING_TILT;
					p.vx = Math.cos(ang) * sp;
					p.vy = Math.sin(ang) * sp * WING_TILT + (rand() - 0.5) * 14;
					p.maxLife = 0.7 + rand() * 0.9;
					p.life = p.maxLife;
					p.heat = rand() < 0.5 ? 0 : rand() < 0.6 ? 1 : 2;
				}
			}
			// Drift + draw live ejecta (they keep flying out and fade even after
			// recording stops, so the burst tails off naturally).
			for (const p of ejecta) {
				if (p.life <= 0) continue;
				p.life -= dt;
				p.x += p.vx * dt;
				p.y += p.vy * dt;
				const k = p.life / p.maxLife;
				if (k <= 0) continue;
				cell(p.x, p.y, HEAT[p.heat], k * (0.55 + 0.45 * level));
			}

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
			onPointerEnter={() => {
				hoverRef.current = true;
			}}
			onPointerLeave={() => {
				hoverRef.current = false;
			}}
			aria-label={state === "recording" ? "Stop recording" : "Start recording"}
		>
			{/* Internal resolution stays SIZE×SIZE (set in the effect); the displayed
			    size is responsive via CSS and stays crisp through image-rendering. */}
			<canvas ref={canvasRef} className="recorder-hole-canvas" />
		</button>
	);
}
