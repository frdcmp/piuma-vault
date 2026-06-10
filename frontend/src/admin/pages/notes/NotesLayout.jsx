import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import WorkspaceShell from "../../../chat/WorkspaceShell";
import { useNotesLiveUpdates } from "../../../queries/notesQuery";
import useChatDockStore from "../../../store/chatDockStore";
import useNoteControlsStore from "../../../store/noteControlsStore";
import useNotesWorkspaceStore from "../../../store/notesWorkspaceStore";
import useUiStore from "../../../store/uiStore";
import PiumaHome from "../../components/notes/PiumaHome";
import NoteControls from "./NoteControls";
import NotesListSidebar from "./NotesListSidebar";
import NoteTabs from "./NoteTabs";
import "./NotesSidebar.css";

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 320;
const SIDEBAR_STORAGE_KEY = "pv:notes-sidebar-width";

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

/**
 * Three-column shell: notes tree (left) | editor / empty (middle) | chat (right).
 * The left sidebar is resizable and persists its width to localStorage; the
 * right chat column is the shared dock provided by WorkspaceShell (open/width
 * state lives in chatDockStore). On mobile only one column is visible at a time.
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
	const reorderTabs = useNotesWorkspaceStore((s) => s.reorderTabs);
	const controlsPresent = useNoteControlsStore((s) => s.present);

	// Chat dock chrome lives in the shared store; the layout only needs `open`
	// (mobile single-column gating) and `closeChat` (collapse after opening a
	// note on mobile). Opening the chat is wired directly in the child controls.
	const chatOpen = useChatDockStore((s) => s.open);
	const closeChat = useChatDockStore((s) => s.closeChat);

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
	// redirect to root (e.g. /notes/undefined → /notes)
	useEffect(() => {
		if (id && id !== "new" && !UUID_RE.test(id)) {
			navigate("/notes", { replace: true });
		}
	}, [id, navigate]);

	const isRoot =
		location.pathname === "/notes" ||
		location.pathname === "/notes/" ||
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

	useEffect(() => {
		if (!isResizingSidebar) return;
		const onMove = (e) => {
			setSidebarWidth(clampWidth(e.clientX, SIDEBAR_MIN, SIDEBAR_MAX));
		};
		const onUp = () => setIsResizingSidebar(false);
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
	}, [isResizingSidebar]);

	useEffect(() => {
		try {
			localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth));
		} catch {
			/* localStorage unavailable */
		}
	}, [sidebarWidth]);

	const handleSelectNote = (noteId) => {
		if (noteId) {
			navigate(`/notes/${noteId}`);
		} else {
			navigate("/notes");
		}
	};

	// Closing a tab: drop it, and if it was the active note, fall back to the
	// nearest remaining tab (right neighbour, else left), or the empty state.
	const handleCloseTab = useCallback(
		(tabId) => {
			if (tabId === activeNoteId) {
				const idx = tabs.findIndex((t) => t.id === tabId);
				const next = tabs[idx + 1] || tabs[idx - 1];
				navigate(next ? `/notes/${next.id}` : "/notes");
			}
			closeTab(tabId);
		},
		[activeNoteId, tabs, navigate, closeTab],
	);

	// On mobile only one column is visible at a time: chat (when open) >
	// empty state (toggled) > sidebar (root) > content (editor). The chat itself
	// is rendered by WorkspaceShell as a full-screen overlay on mobile.
	const mobileChatOpen = isMobile && chatOpen;
	const mobileEmptyInline =
		isMobile && isRoot && mobileShowEmpty && !mobileChatOpen;
	const showSidebar =
		(!isMobile || isRoot) && !mobileEmptyInline && !mobileChatOpen;
	const showContent = (!isMobile || !isRoot) && !mobileChatOpen;

	return (
		<WorkspaceShell
			onOpenNote={(noteId) => {
				handleSelectNote(noteId);
				// On mobile only one column shows at a time, so reveal the editor
				// by closing the chat after navigating to the note.
				if (isMobile) closeChat();
			}}
		>
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
						<PiumaHome onBack={() => setMobileShowEmpty(false)} />
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
									onReorder={reorderTabs}
								/>
								{controlsPresent && (
									<NoteControls
										onClose={() => navigate("/notes")}
										compact={contentNarrow}
									/>
								)}
							</div>
						)}
						{!isRoot ? <Outlet /> : <PiumaHome />}
					</div>
				)}
			</div>
		</WorkspaceShell>
	);
}
