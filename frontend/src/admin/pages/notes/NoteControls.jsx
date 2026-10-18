import { useEffect, useRef, useState } from "react";
import { PvIconButton, PvInput } from "@/ui";
import useNoteControlsStore from "../../../store/noteControlsStore";
import NoteHistoryPopover from "../../components/notes/NoteHistoryPopover";
import SharePopover from "../../components/notes/SharePopover";

// Save-status pill — mirrors the icon the editor header used to show. Shared
// with the mobile editor header (NoteEditor).
const SAVE_ICONS = { saving: "⏳", error: "×" };
export function SaveDot({ status }) {
	const tone =
		status === "saving" ? " is-saving" : status === "error" ? " is-error" : "";
	return (
		<span className={`note-ctl-save${tone}`} title={`Save status: ${status}`}>
			{SAVE_ICONS[status] ?? "✓"}
		</span>
	);
}

// Search-in-page popover. Renders the input + match counter + prev/next nav
// anchored under the 🔍 icon. State lives in the store so NoteEditor can feed
// the query into Milkdown and write match counts back up.
function SearchPopover() {
	const searchQuery = useNoteControlsStore((s) => s.searchQuery);
	const searchCount = useNoteControlsStore((s) => s.searchCount);
	const searchIndex = useNoteControlsStore((s) => s.searchIndex);
	const setSearchQuery = useNoteControlsStore((s) => s.setSearchQuery);
	const setSearchAction = useNoteControlsStore((s) => s.setSearchAction);
	const closeSearch = useNoteControlsStore((s) => s.closeSearch);
	const inputRef = useRef(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	return (
		<div className="note-search-pop">
			<div className="note-search-pop-row">
				<PvInput
					ref={inputRef}
					size="sm"
					className="note-search-pop-input"
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							setSearchAction({
								dir: e.shiftKey ? "prev" : "next",
								ts: Date.now(),
							});
						}
						if (e.key === "Escape") {
							closeSearch();
						}
					}}
					placeholder="Search in page..."
				/>
				{searchQuery && (
					<span className="note-search-pop-count">
						{searchCount > 0 ? `${searchIndex + 1}/${searchCount}` : "0/0"}
					</span>
				)}
			</div>
			<PvIconButton
				size="sm"
				icon="▲"
				label="Previous (Shift+Enter)"
				disabled={!searchQuery}
				onClick={() => setSearchAction({ dir: "prev", ts: Date.now() })}
			/>
			<PvIconButton
				size="sm"
				icon="▼"
				label="Next (Enter)"
				disabled={!searchQuery}
				onClick={() => setSearchAction({ dir: "next", ts: Date.now() })}
			/>
			<PvIconButton
				size="sm"
				variant="ghost"
				icon="×"
				label="Close search"
				onClick={closeSearch}
			/>
		</div>
	);
}

// The editor commands, lifted out of the per-note header into the shared top
// bar beside the tabs. When the bar is too narrow (`compact`) the action
// buttons collapse into a single ⋯ overflow menu.
export default function NoteControls({ onClose, compact }) {
	const noteId = useNoteControlsStore((s) => s.noteId);
	const saveStatus = useNoteControlsStore((s) => s.saveStatus);
	const searchOpen = useNoteControlsStore((s) => s.searchOpen);
	const openSearch = useNoteControlsStore((s) => s.openSearch);
	const closeSearch = useNoteControlsStore((s) => s.closeSearch);

	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef(null);
	const searchRef = useRef(null);

	useEffect(() => {
		if (!menuOpen) return;
		const onDown = (e) => {
			if (menuRef.current && !menuRef.current.contains(e.target)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [menuOpen]);

	// Dismiss the search popover when clicking elsewhere.
	useEffect(() => {
		if (!searchOpen) return;
		const onDown = (e) => {
			if (searchRef.current && !searchRef.current.contains(e.target)) {
				closeSearch();
			}
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [searchOpen, closeSearch]);

	// Ctrl/Cmd+F opens the in-page search (overriding the browser's native
	// find) and the popover auto-focuses its input; Escape closes it. Active
	// only while the controls are mounted, i.e. a note is open.
	useEffect(() => {
		const onKey = (e) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
				e.preventDefault();
				if (!searchOpen) openSearch();
			} else if (e.key === "Escape" && searchOpen) {
				closeSearch();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [searchOpen, openSearch, closeSearch]);

	// Close the menu after firing an action.
	const run = (fn) => () => {
		setMenuOpen(false);
		fn?.();
	};

	if (compact) {
		return (
			<div className="note-controls compact" ref={menuRef}>
				<SaveDot status={saveStatus} />
				<span className="note-search-anchor" ref={searchRef}>
					<PvIconButton
						icon="🔍"
						label="Search in page"
						onClick={() => {
							setMenuOpen(false);
							searchOpen ? closeSearch() : openSearch();
						}}
						aria-haspopup="dialog"
						aria-expanded={searchOpen}
					/>
					{searchOpen && <SearchPopover />}
				</span>
				<PvIconButton
					icon="⋯"
					label="Note actions"
					onClick={() => setMenuOpen((o) => !o)}
					aria-haspopup="menu"
					aria-expanded={menuOpen}
				/>
				{noteId ? <NoteHistoryPopover noteId={noteId} /> : null}
				{menuOpen && (
					<div className="note-ctl-menu" role="menu">
						{noteId ? (
							<div className="note-ctl-menu-item note-ctl-menu-share">
								<SharePopover noteId={noteId} />
							</div>
						) : null}
						<button
							type="button"
							className="note-ctl-menu-item danger"
							onClick={run(onClose)}
						>
							× Close note
						</button>
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="note-controls">
			<SaveDot status={saveStatus} />
			<span className="note-search-anchor" ref={searchRef}>
				<PvIconButton
					icon="🔍"
					label="Search in page"
					onClick={() => (searchOpen ? closeSearch() : openSearch())}
					aria-haspopup="dialog"
					aria-expanded={searchOpen}
				/>
				{searchOpen && <SearchPopover />}
			</span>
			{noteId ? <NoteHistoryPopover noteId={noteId} /> : null}
			{noteId ? <SharePopover noteId={noteId} iconOnly /> : null}
			<PvIconButton
				variant="danger"
				icon="×"
				label="Close note"
				onClick={onClose}
			/>
		</div>
	);
}
