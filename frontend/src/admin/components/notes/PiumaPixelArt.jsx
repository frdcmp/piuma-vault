import { useEffect, useRef, useState } from "react";
import { legFrameAt, Sprite, useSprite } from "../../../sprites";
import "./PiumaPixelArt.css";

const GRAVITY = 2600; // px/s², downward pull while falling
const RESTITUTION = 0.34; // energy kept on each bounce
const BOUNCE_CUTOFF = 320; // below this impact speed, stop bouncing and walk
const WALK_SPEED = 160; // px/s along the ground back toward center
const MAX_THROW = 1300; // clamp on release velocity
const DRAG_THRESHOLD = 4; // px of movement before a press counts as a drag

export default function PiumaPixelArt({ pixelSize = 8 }) {
	const { body, idleLegs, walkLegs, walkFrameMs } = useSprite();
	const elRef = useRef(null);
	// Toggled on a tap (not a drag) to play a one-shot jump over the idle float.
	const [jumping, setJumping] = useState(false);
	// -1 = idle (static legs); 0/1 = gallop frame shown while walking home.
	const [legFrame, setLegFrame] = useState(-1);

	// All interaction/physics state lives in a ref so the rAF loop never triggers
	// a React re-render. Phases: idle → dragging → falling → walking → returning.
	const sim = useRef({
		phase: "idle",
		ox: 0, // x offset from home spot
		oy: 0, // y offset from home spot (positive = down)
		vx: 0,
		vy: 0,
		groundOy: 0, // oy value that rests Piuma's feet on the floor
		facing: 1, // 1 = normal, -1 = mirrored
		legFrame: -1, // last gallop frame pushed to React state
		pointerId: null,
		startX: 0,
		startY: 0,
		startOx: 0,
		startOy: 0,
		moved: false,
		lastX: 0,
		lastY: 0,
		lastT: 0,
		t: 0,
		raf: 0,
	});

	useEffect(() => {
		const s = sim.current;
		return () => cancelAnimationFrame(s.raf);
	}, []);

	// Drive the active physics phase one frame at a time.
	const tick = (now) => {
		const s = sim.current;
		const el = elRef.current;
		if (!el) return;
		const dt = Math.min((now - s.lastT) / 1000, 0.032);
		s.lastT = now;
		s.t += dt;

		if (s.phase === "falling") {
			s.vy += GRAVITY * dt;
			s.oy += s.vy * dt;
			s.ox += s.vx * dt;
			s.vx *= 0.992; // mild air drag
			if (s.oy >= s.groundOy) {
				s.oy = s.groundOy;
				if (s.vy > BOUNCE_CUTOFF) {
					s.vy = -s.vy * RESTITUTION; // bounce
					s.vx *= 0.6;
				} else {
					s.vy = 0;
					s.phase = "walking"; // landed — stroll home
				}
			}
			el.style.transform = `translate(${s.ox}px, ${s.oy}px) scaleX(${s.facing})`;
			s.raf = requestAnimationFrame(tick);
			return;
		}

		if (s.phase === "walking") {
			const dir = s.ox > 0 ? -1 : 1;
			// Sprite faces left by default, so mirror only when walking right.
			s.facing = dir < 0 ? 1 : -1;
			s.ox += dir * WALK_SPEED * dt;
			// Swap the walk legs on the shared cadence.
			const frame = legFrameAt(s.t * 1000, walkLegs.length, walkFrameMs);
			if (frame !== s.legFrame) {
				s.legFrame = frame;
				setLegFrame(frame);
			}
			if ((dir < 0 && s.ox <= 0) || (dir > 0 && s.ox >= 0)) {
				s.ox = 0;
				s.facing = 1;
				s.legFrame = -1;
				setLegFrame(-1); // back to still legs
				s.phase = "returning"; // reached center — hop back up to the spot
			}
			// A little bobbing gait while walking.
			const bob = Math.abs(Math.sin(s.t * 12)) * 4;
			el.style.transform = `translate(${s.ox}px, ${s.groundOy - bob}px) scaleX(${s.facing})`;
			s.raf = requestAnimationFrame(tick);
			return;
		}

		if (s.phase === "returning") {
			s.oy += (0 - s.oy) * Math.min(1, dt * 9); // spring up to home
			if (Math.abs(s.oy) < 0.5) {
				s.oy = 0;
				s.phase = "idle";
				// Hand control back to the CSS idle float.
				el.style.transform = "";
				el.style.animation = "";
				return;
			}
			el.style.transform = `translate(0px, ${s.oy}px) scaleX(1)`;
			s.raf = requestAnimationFrame(tick);
		}
	};

	const startLoop = () => {
		const s = sim.current;
		cancelAnimationFrame(s.raf);
		s.lastT = performance.now();
		s.raf = requestAnimationFrame(tick);
	};

	const onPointerDown = (e) => {
		const s = sim.current;
		const el = elRef.current;
		if (!el) return;
		cancelAnimationFrame(s.raf);
		// Freeze the CSS float so we can measure the natural home position.
		el.style.animation = "none";
		const rect = el.getBoundingClientRect();
		const container = el.closest(".piuma-home-container") || el.parentElement;
		const crect = container.getBoundingClientRect();
		// homeBottom = where Piuma's feet sit with no offset applied.
		const homeBottom = rect.bottom - s.oy;
		s.groundOy = Math.max(0, crect.bottom - homeBottom - 6);
		s.phase = "dragging";
		if (s.legFrame !== -1) {
			s.legFrame = -1;
			setLegFrame(-1); // still legs while held
		}
		s.pointerId = e.pointerId;
		s.startX = e.clientX;
		s.startY = e.clientY;
		s.startOx = s.ox;
		s.startOy = s.oy;
		s.moved = false;
		s.vx = 0;
		s.vy = 0;
		s.lastX = e.clientX;
		s.lastY = e.clientY;
		s.lastT = performance.now();
		el.setPointerCapture(e.pointerId);
		el.style.cursor = "grabbing";
		setJumping(false);
	};

	const onPointerMove = (e) => {
		const s = sim.current;
		if (s.phase !== "dragging" || e.pointerId !== s.pointerId) return;
		const el = elRef.current;
		const dx = e.clientX - s.startX;
		const dy = e.clientY - s.startY;
		if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
			s.moved = true;
		}
		s.ox = s.startOx + dx;
		s.oy = s.startOy + dy;
		const now = performance.now();
		const dt = Math.max((now - s.lastT) / 1000, 0.001);
		s.vx = (e.clientX - s.lastX) / dt;
		s.vy = (e.clientY - s.lastY) / dt;
		s.lastX = e.clientX;
		s.lastY = e.clientY;
		s.lastT = now;
		// Faces left by default → mirror only when moving right.
		if (s.vx < -20) s.facing = 1;
		else if (s.vx > 20) s.facing = -1;
		el.style.transform = `translate(${s.ox}px, ${s.oy}px) scaleX(${s.facing})`;
	};

	const onPointerUp = (e) => {
		const s = sim.current;
		if (s.phase !== "dragging" || e.pointerId !== s.pointerId) return;
		const el = elRef.current;
		el.style.cursor = "";
		try {
			el.releasePointerCapture(e.pointerId);
		} catch {
			/* capture may already be gone */
		}
		s.pointerId = null;
		if (!s.moved) {
			// A plain tap — restore the float and play the jump.
			s.phase = "idle";
			el.style.transform = "";
			el.style.animation = "";
			setJumping(true);
			return;
		}
		s.vx = Math.max(-MAX_THROW, Math.min(MAX_THROW, s.vx));
		s.vy = Math.max(-MAX_THROW, Math.min(MAX_THROW, s.vy));
		if (s.oy > s.groundOy) s.oy = s.groundOy;
		s.phase = "falling";
		startLoop();
	};

	return (
		<button
			ref={elRef}
			type="button"
			className={`piuma-pixel-art${jumping ? " is-jumping" : ""}`}
			aria-label="Boop or drag Piuma"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onAnimationEnd={(ev) => {
				if (ev.animationName === "piuma-jump") setJumping(false);
			}}
			style={{ display: "inline-block", lineHeight: 0 }}
		>
			<Sprite
				rows={[...body, ...(legFrame >= 0 ? walkLegs[legFrame] : idleLegs)]}
				pixelSize={pixelSize}
			/>
		</button>
	);
}
