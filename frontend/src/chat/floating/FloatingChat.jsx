import { useCallback, useEffect, useRef, useState } from "react";
import { useRecordingChat } from "../../queries";
import ChatConversation from "../page/ChatConversation";
import "../chat-shared.css";
import "../page/page.css";
import "./floating.css";

// A draggable, minimizable chat window floating over the page, bound to one
// recording's own conversation: ask Piuma about what is being (or was)
// recorded. The backend hands the model the transcript on every turn — live
// while recording — so the chat itself is the ordinary ChatConversation.

const POS_KEY = "piuma:floating-chat-pos";
const OPEN_KEY = "piuma:floating-chat-open";
const MARGIN = 12;
// Matches .fchat-window's default size in floating.css.
const DEFAULT_W = 400;
const DEFAULT_H = 560;

const readJson = (key, fallback) => {
	try {
		const raw = localStorage.getItem(key);
		return raw == null ? fallback : JSON.parse(raw);
	} catch {
		return fallback;
	}
};

const writeJson = (key, value) => {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* localStorage unavailable */
	}
};

// Keep the window's top-left inside the viewport (its header always reachable).
const clamp = ({ x, y }, w, h) => ({
	x: Math.min(
		Math.max(MARGIN, x),
		Math.max(MARGIN, window.innerWidth - w - MARGIN),
	),
	y: Math.min(
		Math.max(MARGIN, y),
		Math.max(MARGIN, window.innerHeight - h - MARGIN),
	),
});

// Bottom-right by default.
const defaultPos = (w, h) =>
	clamp(
		{ x: window.innerWidth - w - 24, y: window.innerHeight - h - 24 },
		w,
		h,
	);

export default function FloatingChat({ recordingId }) {
	const { data: conv, isError } = useRecordingChat(recordingId);
	const [open, setOpen] = useState(() => readJson(OPEN_KEY, true));
	const winRef = useRef(null);
	const size = useRef({ w: DEFAULT_W, h: DEFAULT_H });
	const [pos, setPos] = useState(() =>
		clamp(readJson(POS_KEY, defaultPos(DEFAULT_W, DEFAULT_H)), DEFAULT_W, 48),
	);
	const drag = useRef(null);

	const setOpenPersist = (v) => {
		setOpen(v);
		writeJson(OPEN_KEY, v);
	};

	// Track the (user-resizable) window size so clamping uses the real box.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the window element remounts each time it reopens, so re-observe on `open`
	useEffect(() => {
		const el = winRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(([entry]) => {
			size.current = {
				w: entry.contentRect.width,
				h: entry.contentRect.height,
			};
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [open]);

	// Stay on screen when the browser window shrinks.
	useEffect(() => {
		const onResize = () =>
			setPos((p) => clamp(p, size.current.w, open ? size.current.h : 48));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [open]);

	const onPointerDown = useCallback(
		(e) => {
			if (e.button !== 0 || e.target.closest("button")) return;
			e.currentTarget.setPointerCapture(e.pointerId);
			drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
		},
		[pos],
	);
	const onPointerMove = useCallback(
		(e) => {
			if (!drag.current) return;
			setPos(
				clamp(
					{ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy },
					size.current.w,
					open ? size.current.h : 48,
				),
			);
		},
		[open],
	);
	const onPointerUp = useCallback(() => {
		if (!drag.current) return;
		drag.current = null;
		setPos((p) => {
			writeJson(POS_KEY, p);
			return p;
		});
	}, []);

	const dragProps = {
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onPointerCancel: onPointerUp,
	};

	if (!open) {
		return (
			<div
				className="fchat-pill"
				style={{ left: pos.x, top: pos.y }}
				{...dragProps}
			>
				<span className="fchat-grip" aria-hidden="true">
					⠿
				</span>
				<button
					type="button"
					className="fchat-pill-btn"
					onClick={() => setOpenPersist(true)}
				>
					◈ ASK PIUMA ABOUT THIS RECORDING
				</button>
			</div>
		);
	}

	return (
		<div
			ref={winRef}
			className="fchat-window"
			style={{ left: pos.x, top: pos.y }}
		>
			<div className="fchat-bar" {...dragProps}>
				<span className="fchat-grip" aria-hidden="true">
					⠿
				</span>
				<span className="fchat-bar-title">◈ piuma · about this recording</span>
				<button
					type="button"
					className="fchat-bar-btn"
					onClick={() => setOpenPersist(false)}
					title="Minimize"
					aria-label="Minimize chat"
				>
					–
				</button>
			</div>
			<div className="fchat-body">
				{conv?.id ? (
					<ChatConversation conversationId={conv.id} />
				) : (
					<p className="fchat-status">
						{isError ? "Couldn't open this recording's chat." : "Opening chat…"}
					</p>
				)}
			</div>
		</div>
	);
}
