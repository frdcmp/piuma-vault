import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import ChatPanel from "../../../chat/ChatPanel";
import { useNotesLiveUpdates } from "../../../queries/notesQuery";
import useNoteControlsStore from "../../../store/noteControlsStore";
import useNotesWorkspaceStore from "../../../store/notesWorkspaceStore";
import useUiStore from "../../../store/uiStore";
import PiumaEmptyState from "../../components/notes/PiumaEmptyState";
import NoteControls from "./NoteControls";
import NotesListSidebar from "./NotesListSidebar";
import NoteTabs from "./NoteTabs";
import "./NotesSidebar.css";

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 320;
const SIDEBAR_STORAGE_KEY = "pv:notes-sidebar-width";

const CHAT_MIN = 220;
const CHAT_MAX = 560;
const CHAT_DEFAULT = 360;
const CHAT_WIDTH_STORAGE_KEY = "pv:notes-chat-width";
const CHAT_OPEN_STORAGE_KEY = "pv:notes-chat-open";

const clampWidth = (n, min, max) => Math.min(max, Math.max(min, Math.round(n)));

const readStoredNumber = (key, fallback, min, max) => {
	try {
		const raw = localStorage.getItem(key);
		const n = raw == null ? fallback : Number.parseInt(raw, 10);
		return clampWidth(Number.isFinite(n) ? n : fallback, min, max);
	} catch {
		return fallback;
	}
};

const readStoredBool = (key) => {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
};

/**
 * Three-column shell: notes tree (left) | editor / empty (middle) | chat (right).
 * Each side is resizable and persists its width to localStorage. Chat panel is
 * collapsed by default; opened via the editor header button or empty-state
 * Chat button. On mobile only one column is visible at a time.
 */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function NotesLayout() {
	const { id } = useParams();
	const navigate = useNavigate();
	const location = useLocation();
	const { isMobile, handleResize } = useUiStore();
	const tabs = useNotesWorkspaceStore((s) => s.tabs);
	const closeTab = useNotesWorkspaceStore((s) => s.closeTab);
	const pinTab = useNotesWorkspaceStore((s) => s.pinTab);
	const controlsPresent = useNoteControlsStore((s) => s.present);

	// When the content column is narrow (e.g. chat panel open), the top-bar
	// controls collapse into a ⋯ overflow menu.
	const contentRef = useRef(null);
	const [contentNarrow, setContentNarrow] = useState(false);
	useEffect(() => {
		const el = contentRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(([entry]) => {
			setContentNarrow(entry.contentRect.width < 560);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// Guard: if :id param is present but not a valid UUID and not "new",
	// redirect to root (e.g. /undefined → /)
	useEffect(() => {
		if (id && id !== "new" && !UUID_RE.test(id)) {
			navigate("/", { replace: true });
		}
	}, [id, navigate]);

	const isRoot =
		location.pathname === "/" ||
		location.pathname === "" ||
		(id && id !== "new" && !UUID_RE.test(id));
	const activeNoteId = UUID_RE.test(id)
		? id
		: location.pathname.endsWith("/new")
			? "new"
			: undefined;

	useNotesLiveUpdates(UUID_RE.test(activeNoteId) ? activeNoteId : null);

	useEffect(() => {
		handleResize();
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [handleResize]);

	const [sidebarWidth, setSidebarWidth] = useState(() =>
		readStoredNumber(
			SIDEBAR_STORAGE_KEY,
			SIDEBAR_DEFAULT,
			SIDEBAR_MIN,
			SIDEBAR_MAX,
		),
	);
	const [isResizingSidebar, setIsResizingSidebar] = useState(false);

	const [chatOpen, setChatOpen] = useState(() =>
		readStoredBool(CHAT_OPEN_STORAGE_KEY),
	);
	const [chatWidth, setChatWidth] = useState(() =>
		readStoredNumber(CHAT_WIDTH_STORAGE_KEY, CHAT_DEFAULT, CHAT_MIN, CHAT_MAX),
	);
	const [isResizingChat, setIsResizingChat] = useState(false);

	const openChat = useCallback(() => setChatOpen(true), []);
	const closeChat = useCallback(() => setChatOpen(false), []);

	// Mobile-only toggle: from the sidebar's X button, switch the root view to
	// the empty state (dog + Chat). The empty state has a small back icon to
	// return here. Reset whenever the route changes off /.
	const [mobileShowEmpty, setMobileShowEmpty] = useState(false);

	useEffect(() => {
		if (!isRoot) setMobileShowEmpty(false);
	}, [isRoot]);

	const startSidebarResize = useCallback((e) => {
		e.preventDefault();
		setIsResizingSidebar(true);
	}, []);

	const startChatResize = useCallback((e) => {
		e.preventDefault();
		setIsResizingChat(true);
	}, []);

	useEffect(() => {
		if (!isResizingSidebar && !isResizingChat) return;
		const onMove = (e) => {
			if (isResizingSidebar) {
				setSidebarWidth(clampWidth(e.clientX, SIDEBAR_MIN, SIDEBAR_MAX));
			} else if (isResizingChat) {
				setChatWidth(
					clampWidth(window.innerWidth - e.clientX, CHAT_MIN, CHAT_MAX),
				);
			}
		};
		const onUp = () => {
			setIsResizingSidebar(false);
			setIsResizingChat(false);
		};
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
	}, [isResizingSidebar, isResizingChat]);

	useEffect(() => {
		try {
			localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth));
		} catch {
			/* localStorage unavailable */
		}
	}, [sidebarWidth]);

	useEffect(() => {
		try {
			localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(chatWidth));
		} catch {
			/* localStorage unavailable */
		}
	}, [chatWidth]);

	useEffect(() => {
		try {
			localStorage.setItem(CHAT_OPEN_STORAGE_KEY, chatOpen ? "1" : "0");
		} catch {
			/* localStorage unavailable */
		}
	}, [chatOpen]);

	const handleSelectNote = (noteId) => {
		if (noteId) {
			navigate(`/${noteId}`);
		} else {
			navigate("/");
		}
	};

	// Closing a tab: drop it, and if it was the active note, fall back to the
	// nearest remaining tab (right neighbour, else left), or the empty state.
	const handleCloseTab = useCallback(
		(tabId) => {
			if (tabId === activeNoteId) {
				const idx = tabs.findIndex((t) => t.id === tabId);
				const next = tabs[idx + 1] || tabs[idx - 1];
				navigate(next ? `/${next.id}` : "/");
			}
			closeTab(tabId);
		},
		[activeNoteId, tabs, navigate, closeTab],
	);

	// On mobile only one column is visible at a time: chat (when open) >
	// empty state (toggled) > sidebar (root) > content (editor).
	const mobileChatOpen = isMobile && chatOpen;
	const mobileEmptyInline =
		isMobile && isRoot && mobileShowEmpty && !mobileChatOpen;
	const showSidebar =
		(!isMobile || isRoot) && !mobileEmptyInline && !mobileChatOpen;
	const showContent = (!isMobile || !isRoot) && !mobileChatOpen;
	const showChat = chatOpen && (!isMobile || mobileChatOpen);

	return (
		<div className="notes-pixel-layout">
			{showSidebar && (
				<div
					className={`notes-pixel-sidebar ${isMobile ? "mobile" : ""}`}
					style={isMobile ? undefined : { width: sidebarWidth }}
				>
					<NotesListSidebar
						selectedNoteId={activeNoteId}
						onSelectNote={handleSelectNote}
						onClose={isMobile ? () => setMobileShowEmpty(true) : undefined}
					/>
				</div>
			)}

			{mobileEmptyInline && (
				<div className="notes-pixel-sidebar mobile">
					<PiumaEmptyState
						onBack={() => setMobileShowEmpty(false)}
						onOpenChat={openChat}
					/>
				</div>
			)}

			{showSidebar && !isMobile && (
				// biome-ignore lint/a11y/useSemanticElements: <hr> is not interactive; this is a draggable resizer
				<div
					className={`notes-sidebar-resizer ${isResizingSidebar ? "active" : ""}`}
					onMouseDown={startSidebarResize}
					onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
					onKeyDown={(e) => {
						const step = e.shiftKey ? 32 : 8;
						if (e.key === "ArrowLeft")
							setSidebarWidth((w) =>
								clampWidth(w - step, SIDEBAR_MIN, SIDEBAR_MAX),
							);
						else if (e.key === "ArrowRight")
							setSidebarWidth((w) =>
								clampWidth(w + step, SIDEBAR_MIN, SIDEBAR_MAX),
							);
						else if (e.key === "Home") setSidebarWidth(SIDEBAR_MIN);
						else if (e.key === "End") setSidebarWidth(SIDEBAR_MAX);
						else return;
						e.preventDefault();
					}}
					role="separator"
					tabIndex={0}
					aria-orientation="vertical"
					aria-label="Resize sidebar"
					aria-valuenow={sidebarWidth}
					aria-valuemin={SIDEBAR_MIN}
					aria-valuemax={SIDEBAR_MAX}
					title="Drag to resize · double-click to reset"
				/>
			)}

			{showContent && (
				<div className="notes-pixel-content" ref={contentRef}>
					{!isMobile && (tabs.length > 0 || controlsPresent) && (
						<div className="note-topbar">
							<NoteTabs
								tabs={tabs}
								activeId={activeNoteId}
								onSelect={handleSelectNote}
								onClose={handleCloseTab}
								onPin={pinTab}
							/>
							{controlsPresent && (
								<NoteControls
									openChat={chatOpen ? null : openChat}
									onClose={() => navigate("/")}
									compact={contentNarrow}
								/>
							)}
						</div>
					)}
					{!isRoot ? (
						<Outlet context={{ openChat, closeChat, chatOpen }} />
					) : (
						<PiumaEmptyState onOpenChat={openChat} />
					)}
				</div>
			)}

			{showChat && !isMobile && (
				// biome-ignore lint/a11y/useSemanticElements: draggable resizer for the chat column
				<div
					className={`notes-sidebar-resizer ${isResizingChat ? "active" : ""}`}
					onMouseDown={startChatResize}
					onDoubleClick={() => setChatWidth(CHAT_DEFAULT)}
					onKeyDown={(e) => {
						const step = e.shiftKey ? 32 : 8;
						if (e.key === "ArrowLeft")
							setChatWidth((w) => clampWidth(w + step, CHAT_MIN, CHAT_MAX));
						else if (e.key === "ArrowRight")
							setChatWidth((w) => clampWidth(w - step, CHAT_MIN, CHAT_MAX));
						else if (e.key === "Home") setChatWidth(CHAT_MAX);
						else if (e.key === "End") setChatWidth(CHAT_MIN);
						else return;
						e.preventDefault();
					}}
					role="separator"
					tabIndex={0}
					aria-orientation="vertical"
					aria-label="Resize chat"
					aria-valuenow={chatWidth}
					aria-valuemin={CHAT_MIN}
					aria-valuemax={CHAT_MAX}
					title="Drag to resize · double-click to reset"
				/>
			)}

			{showChat && (
				<div
					className={`notes-pixel-chat ${isMobile ? "mobile" : ""}`}
					style={isMobile ? undefined : { width: chatWidth }}
				>
					<ChatPanel
						onClose={closeChat}
						onOpenNote={(noteId) => {
							handleSelectNote(noteId);
							// On mobile only one column shows at a time, so reveal the
							// editor by closing the chat after navigating to the note.
							if (isMobile) closeChat();
						}}
					/>
				</div>
			)}
		</div>
	);
}
