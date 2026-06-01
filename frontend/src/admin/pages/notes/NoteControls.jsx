import { useEffect, useRef, useState } from "react";
import useNoteControlsStore from "../../../store/noteControlsStore";
import SharePopover from "../../components/notes/SharePopover";

// Save-status pill — mirrors the icon the editor header used to show.
function SaveDot({ status }) {
	let icon = "✓";
	let color = "var(--accent-2)";
	if (status === "saving") {
		icon = "⏳";
		color = "var(--accent)";
	} else if (status === "error") {
		icon = "×";
		color = "var(--accent-3)";
	}
	return (
		<span
			className="note-ctl-save"
			style={{ color }}
			title={`Save status: ${status}`}
		>
			{icon}
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
				<input
					ref={inputRef}
					className="pixel-input note-search-pop-input"
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
			<div className="note-search-pop-nav">
				<button
					type="button"
					className="search-nav-btn"
					disabled={!searchQuery}
					onClick={() => setSearchAction({ dir: "prev", ts: Date.now() })}
					title="Previous (Shift+Enter)"
				>
					▲
				</button>
				<button
					type="button"
					className="search-nav-btn"
					disabled={!searchQuery}
					onClick={() => setSearchAction({ dir: "next", ts: Date.now() })}
					title="Next (Enter)"
				>
					▼
				</button>
			</div>
			<button
				type="button"
				className="note-ctl-btn"
				onClick={closeSearch}
				title="Close search"
				aria-label="Close search"
			>
				×
			</button>
		</div>
	);
}

// The editor commands, lifted out of the per-note header into the shared top
// bar beside the tabs. When the bar is too narrow (`compact`) the action
// buttons collapse into a single ⋯ overflow menu.
export default function NoteControls({ openChat, onClose, compact }) {
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
					<button
						type="button"
						className="note-ctl-btn"
						onClick={() => {
							setMenuOpen(false);
							searchOpen ? closeSearch() : openSearch();
						}}
						aria-haspopup="dialog"
						aria-expanded={searchOpen}
						title="Search in page"
						aria-label="Search in page"
					>
						🔍
					</button>
					{searchOpen && <SearchPopover />}
				</span>
				<button
					type="button"
					className="note-ctl-btn"
					onClick={() => setMenuOpen((o) => !o)}
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					title="Note actions"
				>
					⋯
				</button>
				{menuOpen && (
					<div className="note-ctl-menu" role="menu">
						{noteId ? (
							<div className="note-ctl-menu-item note-ctl-menu-share">
								<SharePopover noteId={noteId} />
							</div>
						) : null}
						{openChat ? (
							<button
								type="button"
								className="note-ctl-menu-item"
								onClick={run(openChat)}
							>
								💬 Chat about note
							</button>
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
				<button
					type="button"
					className="note-ctl-btn"
					onClick={() => (searchOpen ? closeSearch() : openSearch())}
					title="Search in page"
					aria-label="Search in page"
					aria-haspopup="dialog"
					aria-expanded={searchOpen}
				>
					🔍
				</button>
				{searchOpen && <SearchPopover />}
			</span>
			{noteId ? <SharePopover noteId={noteId} iconOnly /> : null}
			{openChat ? (
				<button
					type="button"
					className="note-ctl-btn"
					onClick={openChat}
					title="Open chat about this note"
					aria-label="Open chat"
				>
					💬
				</button>
			) : null}
			<button
				type="button"
				className="note-ctl-btn danger"
				onClick={onClose}
				title="Close note"
				aria-label="Close note"
			>
				×
			</button>
		</div>
	);
}
