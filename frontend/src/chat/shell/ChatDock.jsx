import { useEffect } from "react";
import useChatDockStore, {
	CHAT_MAX,
	CHAT_MIN,
} from "../../store/chatDockStore";
import useUiStore from "../../store/uiStore";
import ChatPanel from "../dock/ChatPanel";
import "./ChatDock.css";

// The shared right-side chat column, rendered as the last child of a
// .workspace-shell flex row (see WorkspaceShell.jsx). When open it appends a
// resizer + the chat column; when closed it shows a floating toggle button.
// Open/width state lives in chatDockStore so it's unified across pages and any
// component can open the chat; the conversation itself is persisted by ChatPanel.

export default function ChatDock({ onOpenNote }) {
	const { isMobile } = useUiStore();
	const open = useChatDockStore((s) => s.open);
	const width = useChatDockStore((s) => s.width);
	const isResizing = useChatDockStore((s) => s.isResizing);
	const openChat = useChatDockStore((s) => s.openChat);
	const closeChat = useChatDockStore((s) => s.closeChat);
	const setWidth = useChatDockStore((s) => s.setWidth);
	const resetWidth = useChatDockStore((s) => s.resetWidth);
	const setResizing = useChatDockStore((s) => s.setResizing);

	useEffect(() => {
		if (!isResizing) return;
		const onMove = (e) => setWidth(window.innerWidth - e.clientX);
		const onUp = () => setResizing(false);
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
	}, [isResizing, setWidth, setResizing]);

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
						setResizing(true);
					}}
					onDoubleClick={resetWidth}
					onKeyDown={(e) => {
						const step = e.shiftKey ? 32 : 8;
						if (e.key === "ArrowLeft") setWidth(width + step);
						else if (e.key === "ArrowRight") setWidth(width - step);
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
