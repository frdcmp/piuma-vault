import { useEffect, useRef } from "react";
import { Sprite, useSprite, useSpriteCycle } from "../../../sprites";

// Pixel waveform analyser. Reads the live AnalyserNode (wired to the mic in
// RecorderPage) and renders chunky mirrored bars on a pixel grid — green at the
// centerline, yellow mid, red at the tips. Also writes the overall RMS level
// into `levelRef` each frame so the black hole can react to the same audio.
// The vault mascot stands beside the meter and walks while audio is flowing.

const PX = 4; // pixel cell size
const COLS = 64; // grid width in cells
const ROWS = 18; // grid height in cells (even → mirrored around the middle)
const BAR_W = 2; // bar width in cells
const GAP = 1; // gap between bars in cells
const W = COLS * PX;
const H = ROWS * PX;
const BARS = Math.floor(COLS / (BAR_W + GAP));
const HALF = ROWS / 2;

// Cell color by distance from the centerline (0 = at center). Recording shows
// the hot green→amber→red meter; idle monitoring shows flat grey so it's
// obvious at a glance whether the mic is actually live or just previewing.
const rowColor = (d, active) =>
	active
		? d < 3
			? "#ff6b6b"
			: d < 6
				? "#f4453f"
				: "#c4282a"
		: d < 3
			? "#6b7280"
			: d < 6
				? "#8a909c"
				: "#a7adb8";

export default function PixelWaveform({ analyserRef, active, levelRef }) {
	const canvasRef = useRef(null);
	const { body, idleLegs, walkLegs, walkFrameMs } = useSprite();
	const frame = useSpriteCycle(walkLegs.length, walkFrameMs, active);
	const legs = active ? walkLegs[frame] || idleLegs : idleLegs;

	// The draw loop lives in an effect that doesn't re-run on `active`; read it
	// through a ref so the live/preview palette switches without restarting RAF.
	const activeRef = useRef(active);
	activeRef.current = active;

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		const dpr = window.devicePixelRatio || 1;
		canvas.width = W * dpr;
		canvas.height = H * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		const data = new Uint8Array(2048);
		// Per-bar smoothed heights so bars fall gracefully instead of flickering.
		const heights = new Array(BARS).fill(0);
		let raf = 0;

		const draw = () => {
			ctx.clearRect(0, 0, W, H);
			const analyser = analyserRef.current;

			if (analyser) {
				const n = Math.min(analyser.fftSize, data.length);
				analyser.getByteTimeDomainData(data.subarray(0, n));
				const slice = Math.floor(n / BARS);
				let sumSq = 0;
				for (let b = 0; b < BARS; b++) {
					// Peak deviation from the midpoint within this bar's slice.
					let peak = 0;
					for (let i = b * slice; i < (b + 1) * slice; i++) {
						const v = Math.abs(data[i] - 128) / 128;
						if (v > peak) peak = v;
						sumSq += v * v;
					}
					const target = Math.min(
						HALF,
						Math.max(1, Math.round(peak * HALF * 2)),
					);
					// Rise fast, decay slow.
					heights[b] =
						target > heights[b] ? target : Math.max(1, heights[b] - 0.6);
				}
				if (levelRef) levelRef.current = Math.min(1, Math.sqrt(sumSq / n) * 3);
			} else {
				// Idle: everything settles back to a flat line.
				for (let b = 0; b < BARS; b++)
					heights[b] = Math.max(1, heights[b] - 0.6);
				if (levelRef) levelRef.current = 0;
			}

			const live = activeRef.current;
			const alpha = live ? 1 : analyser ? 0.6 : 0.35;
			for (let b = 0; b < BARS; b++) {
				const h = Math.round(heights[b]);
				const x = b * (BAR_W + GAP) * PX;
				for (let d = 0; d < h; d++) {
					ctx.fillStyle = rowColor(d, live);
					ctx.globalAlpha = alpha;
					// Mirror each cell above and below the centerline.
					ctx.fillRect(x, (HALF - 1 - d) * PX, BAR_W * PX, PX);
					ctx.fillRect(x, (HALF + d) * PX, BAR_W * PX, PX);
				}
			}
			ctx.globalAlpha = 1;
			raf = requestAnimationFrame(draw);
		};

		raf = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(raf);
	}, [analyserRef, levelRef]);

	return (
		<div className="recorder-meter">
			<div className={`recorder-meter-sprite ${active ? "is-walking" : ""}`}>
				<Sprite rows={[...body, ...legs]} pixelSize={4} />
			</div>
			<canvas
				ref={canvasRef}
				style={{ width: W, height: H }}
				className="recorder-meter-canvas"
			/>
		</div>
	);
}
