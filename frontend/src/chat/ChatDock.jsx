import { useCallback, useEffect, useState } from "react";
import useUiStore from "../store/uiStore";
import ChatPanel from "./ChatPanel";
import "./ChatDock.css";

// A self-contained right-side chat column shared by the Storage and Tasks
// workspaces (the Notes layout has its own richer three-column variant). Render
// it as the LAST child of a flex-row container; when open it appends a resizer +
// the chat column, when closed it shows a floating toggle button. The chat
// conversation itself is persisted by ChatPanel, so it continues across pages.

const CHAT_MIN = 220;
const CHAT_MAX = 560;
const CHAT_DEFAULT = 360;
const CHAT_WIDTH_KEY = "pv:chat-width";
const CHAT_OPEN_KEY = "pv:chat-open";

const clampWidth = (n, min, max) => Math.min(max, Math.max(min, Math.round(n)));

const readStoredWidth = () => {
	try {
		const raw = localStorage.getItem(CHAT_WIDTH_KEY);
		const n = raw == null ? CHAT_DEFAULT : Number.parseInt(raw, 10);
		return clampWidth(
			Number.isFinite(n) ? n : CHAT_DEFAULT,
			CHAT_MIN,
			CHAT_MAX,
		);
	} catch {
		return CHAT_DEFAULT;
	}
};

const readStoredBool = (key) => {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
};

export default function ChatDock({ onOpenNote }) {
	const { isMobile, handleResize } = useUiStore();
	const [open, setOpen] = useState(() => readStoredBool(CHAT_OPEN_KEY));
	const [width, setWidth] = useState(readStoredWidth);
	const [isResizing, setIsResizing] = useState(false);

	const openChat = useCallback(() => setOpen(true), []);
	const closeChat = useCallback(() => setOpen(false), []);

	// Keep isMobile in sync on these standalone pages (no global layout does it).
	useEffect(() => {
		handleResize();
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [handleResize]);

	useEffect(() => {
		try {
			localStorage.setItem(CHAT_OPEN_KEY, open ? "1" : "0");
		} catch {
			/* localStorage unavailable */
		}
	}, [open]);

	useEffect(() => {
		try {
			localStorage.setItem(CHAT_WIDTH_KEY, String(width));
		} catch {
			/* localStorage unavailable */
		}
	}, [width]);

	useEffect(() => {
		if (!isResizing) return;
		const onMove = (e) =>
			setWidth(clampWidth(window.innerWidth - e.clientX, CHAT_MIN, CHAT_MAX));
		const onUp = () => setIsResizing(false);
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		const prevCursor = document.body.style.cursor;
		const prevSelect = document.body.style.userSelect;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevSelect;
		};
	}, [isResizing]);

	if (!open) {
		return (
			<button
				type="button"
				className="chat-dock-fab"
				onClick={openChat}
				title="Chat with Piuma"
				aria-label="Open chat"
			>
				🐾
			</button>
		);
	}

	return (
		<>
			{!isMobile && (
				// biome-ignore lint/a11y/useSemanticElements: draggable resizer for the chat column
				<div
					className={`chat-dock-resizer ${isResizing ? "active" : ""}`}
					onMouseDown={(e) => {
						e.preventDefault();
						setIsResizing(true);
					}}
					onDoubleClick={() => setWidth(CHAT_DEFAULT)}
					onKeyDown={(e) => {
						const step = e.shiftKey ? 32 : 8;
						if (e.key === "ArrowLeft")
							setWidth((w) => clampWidth(w + step, CHAT_MIN, CHAT_MAX));
						else if (e.key === "ArrowRight")
							setWidth((w) => clampWidth(w - step, CHAT_MIN, CHAT_MAX));
						else if (e.key === "Home") setWidth(CHAT_MAX);
						else if (e.key === "End") setWidth(CHAT_MIN);
						else return;
						e.preventDefault();
					}}
					role="separator"
					tabIndex={0}
					aria-orientation="vertical"
					aria-label="Resize chat"
					aria-valuenow={width}
					aria-valuemin={CHAT_MIN}
					aria-valuemax={CHAT_MAX}
					title="Drag to resize · double-click to reset"
				/>
			)}
			<div
				className={`chat-dock-col ${isMobile ? "mobile" : ""}`}
				style={isMobile ? undefined : { width }}
			>
				<ChatPanel onClose={closeChat} onOpenNote={onOpenNote} />
			</div>
		</>
	);
}
