import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { PvModal } from "@/admin/components/ui";
import {
	notesKeys,
	useBrowseFolder,
	useCreateNote,
	useDeleteNote,
	useNote,
	useNotes,
	useRenameFolder,
	useSearchFolders,
	useUpdateNote,
} from "../../../queries/notesQuery";
import useNotesWorkspaceStore from "../../../store/notesWorkspaceStore";
import { formatDate } from "../../../utils/dateTime";
import "./NotesSidebar.css";

const folderLabel = (path) => {
	if (!path || path === "/") return "/";
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] || "/";
};

// Mirrors the mobile `renderTreePrefix`: ancestor trunks tinted in `accent-2`,
// corner chars (`├─` / `└─`) stay muted so each row visibly hangs off its
// parent. `parentLines[i]` true → ancestor at depth i still has more siblings.
const TreePrefix = ({ parentLines, isLast }) => (
	<span className="ftree-prefix">
		{parentLines.map((more, i) => (
			<span
				key={`p${i}-${more ? "t" : "g"}`}
				className={more ? "ftree-trunk" : "ftree-gap"}
			>
				{more ? "│  " : "   "}
			</span>
		))}
		<span className="ftree-branch">{isLast ? "└─ " : "├─ "}</span>
	</span>
);

const TreeFile = ({
	file,
	folder,
	parentLines,
	isLast,
	selected,
	onSelect,
	onOpenPermanent,
	onRequestDelete,
	onSetContextTarget,
	selectedItemRef,
	onDragStartItem,
	dragging,
	contextActive,
}) => (
	<div
		ref={selected ? selectedItemRef : null}
		className={`ftree-row ftree-file ${selected ? "selected" : ""} ${
			dragging ? "dragging" : ""
		} ${contextActive ? "context-active" : ""}`}
		draggable
		onDragStart={(e) => {
			e.stopPropagation();
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", file.id);
			onDragStartItem({ type: "file", id: file.id, folder });
		}}
		onClick={() => onSelect(file.id)}
		onDoubleClick={() => onOpenPermanent(file.id, file)}
		onContextMenu={(e) => {
			e.preventDefault();
			onSetContextTarget({
				type: "file",
				id: file.id,
				path: folder,
				file,
				x: e.clientX,
				y: e.clientY,
			});
		}}
	>
		<TreePrefix parentLines={parentLines} isLast={isLast} />
		<span className="ftree-bullet">{selected ? "▶" : "▸"}</span>
		<span className="ftree-title">{file.title || "Untitled"}</span>
		<span className="ftree-date">{formatDate(file.updated_at)}</span>
		<span
			className="ftree-delete"
			onClick={(e) => {
				e.stopPropagation();
				onRequestDelete(file.id);
			}}
			title="Delete note"
		>
			×
		</span>
	</div>
);

const TreeFolder = ({
	path,
	depth,
	parentLines = [],
	isLast = false,
	selectedNoteId,
	onSelectNote,
	selectedFolderPath,
	onSelectFolder,
	onOpenPermanent,
	onRequestDelete,
	onSetContextTarget,
	expandedFolders,
	toggleFolder,
	selectedItemRef,
	onDragStartItem,
	onDropOnFolder,
	dragOverPath,
	setDragOverPath,
	dragItem,
	contextTarget,
}) => {
	const expanded = depth === 0 || !!expandedFolders[path];
	const { data, isLoading } = useBrowseFolder(expanded ? path : null);

	const subfolders = data?.subfolders || [];
	const files = data?.files || [];
	const childCount = subfolders.length + files.length;
	const childParentLines = depth > 0 ? [...parentLines, !isLast] : parentLines;

	const isDraggingThisFolder =
		dragItem?.type === "folder" && dragItem.path === path;
	const isContextActive =
		contextTarget?.type === "folder" && contextTarget.path === path;
	const isSelectedFolder = selectedFolderPath === path;

	return (
		<div>
			{depth > 0 && (
				<div
					className={`ftree-row ftree-folder ${
						dragOverPath === path ? "drag-over" : ""
					} ${isDraggingThisFolder ? "dragging" : ""} ${
						isContextActive ? "context-active" : ""
					} ${isSelectedFolder ? "selected" : ""}`}
					draggable
					onDragStart={(e) => {
						e.stopPropagation();
						e.dataTransfer.effectAllowed = "move";
						e.dataTransfer.setData("text/plain", path);
						onDragStartItem({ type: "folder", path });
					}}
					onDragOver={(e) => {
						e.preventDefault();
						e.stopPropagation();
						e.dataTransfer.dropEffect = "move";
						if (dragOverPath !== path) setDragOverPath(path);
					}}
					onDrop={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onDropOnFolder(path);
					}}
					onClick={() => {
						onSelectFolder(path);
						toggleFolder(path);
					}}
					onContextMenu={(e) => {
						e.preventDefault();
						onSetContextTarget({
							type: "folder",
							path,
							x: e.clientX,
							y: e.clientY,
						});
					}}
				>
					<TreePrefix parentLines={parentLines} isLast={isLast} />
					<span className="ftree-folder-toggle">
						{expanded ? "[-]" : "[+]"}
					</span>
					<span className="ftree-folder-name">
						{folderLabel(path)}
						<span className="ftree-folder-slash">/</span>
					</span>
					{expanded && childCount > 0 ? (
						<span className="ftree-folder-count">{childCount}</span>
					) : null}
				</div>
			)}
			{expanded && (
				<>
					{isLoading && depth > 0 && (
						<div className="ftree-row ftree-meta">
							<TreePrefix parentLines={childParentLines} isLast={true} />
							<span
								className="ftree-dog-spinner"
								role="status"
								aria-label="Loading notes"
							>
								<span className="ftree-dog-face">🐶</span>
							</span>
							<span className="ftree-dog-label">fetching…</span>
						</div>
					)}
					{subfolders.map((sub, idx) => {
						const subPath = path === "/" ? `/${sub}` : `${path}/${sub}`;
						const isLastChild =
							idx === subfolders.length - 1 && files.length === 0;
						return (
							<TreeFolder
								key={subPath}
								path={subPath}
								depth={depth + 1}
								parentLines={childParentLines}
								isLast={isLastChild}
								selectedNoteId={selectedNoteId}
								onSelectNote={onSelectNote}
								selectedFolderPath={selectedFolderPath}
								onSelectFolder={onSelectFolder}
								onOpenPermanent={onOpenPermanent}
								onRequestDelete={onRequestDelete}
								onSetContextTarget={onSetContextTarget}
								expandedFolders={expandedFolders}
								toggleFolder={toggleFolder}
								selectedItemRef={selectedItemRef}
								onDragStartItem={onDragStartItem}
								onDropOnFolder={onDropOnFolder}
								dragOverPath={dragOverPath}
								setDragOverPath={setDragOverPath}
								dragItem={dragItem}
								contextTarget={contextTarget}
							/>
						);
					})}
					{files.map((file, idx) => {
						const isLastChild = idx === files.length - 1;
						return (
							<TreeFile
								key={file.id}
								file={file}
								folder={path}
								parentLines={childParentLines}
								isLast={isLastChild}
								selected={selectedNoteId === file.id && !selectedFolderPath}
								onSelect={onSelectNote}
								onOpenPermanent={onOpenPermanent}
								onRequestDelete={onRequestDelete}
								onSetContextTarget={onSetContextTarget}
								selectedItemRef={selectedItemRef}
								onDragStartItem={onDragStartItem}
								dragging={dragItem?.type === "file" && dragItem.id === file.id}
								contextActive={
									contextTarget?.type === "file" && contextTarget.id === file.id
								}
							/>
						);
					})}
					{!isLoading && childCount === 0 && depth > 0 && (
						<div className="ftree-row ftree-meta">
							<TreePrefix parentLines={childParentLines} isLast={true} />
							<span className="ftree-empty">(empty)</span>
						</div>
					)}
				</>
			)}
		</div>
	);
};

const SearchResultItem = ({
	note,
	isSelected,
	onSelect,
	onOpenPermanent,
	onRequestDelete,
	onSetContextTarget,
	searchQuery,
}) => {
	const highlightText = (text, query) => {
		if (!query || !text) return text;
		const regex = new RegExp(
			`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
			"gi",
		);
		const parts = text.split(regex);
		return parts.map((part, i) =>
			regex.test(part) ? (
				<b key={i} className="search-match-highlight">
					{part}
				</b>
			) : (
				part
			),
		);
	};

	const highlights =
		note.highlights?.length > 0
			? note.highlights
			: note.headline
				? [note.headline]
				: [];

	return (
		<div
			className={`ftree-row ftree-search ${isSelected ? "selected" : ""}`}
			onClick={() => onSelect(note.id)}
			onDoubleClick={() => onOpenPermanent(note.id, note)}
			onContextMenu={(e) => {
				e.preventDefault();
				onSetContextTarget({
					type: "file",
					id: note.id,
					path: note.folder,
					file: note,
					x: e.clientX,
					y: e.clientY,
				});
			}}
		>
			<div className="ftree-search-top">
				<span className="ftree-bullet">{isSelected ? "▶" : "▸"}</span>
				<span className="ftree-title">
					{highlightText(note.title || "Untitled", searchQuery)}
				</span>
				{note.score !== undefined && note.score !== null && (
					<span className="ftree-score" title="Match Score">
						{note.score.toFixed(2)}
					</span>
				)}
				<span className="ftree-date">{formatDate(note.updated_at)}</span>
				<span
					className="ftree-delete"
					onClick={(e) => {
						e.stopPropagation();
						onRequestDelete(note.id);
					}}
				>
					×
				</span>
			</div>

			{note.folder && note.folder !== "/" && (
				<div className="ftree-search-path">📁 {note.folder}</div>
			)}

			{highlights.map((highlight, i) => (
				<div
					key={i}
					className="ftree-search-headline note-search-headline"
					dangerouslySetInnerHTML={{ __html: highlight }}
				/>
			))}
		</div>
	);
};

export default function NotesListSidebar({
	selectedNoteId,
	onSelectNote,
	onClose,
}) {
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const searchTimerRef = useRef(null);
	const [expandedFolders, setExpandedFolders] = useState({ "/": true });
	const [selectedFolderPath, setSelectedFolderPath] = useState(null);
	const [showNotes, setShowNotes] = useState(true);
	const [showFolders, setShowFolders] = useState(true);

	// Toggle a scope, but keep at least one enabled — turning off the last one
	// would leave the user with empty results and no obvious way to recover.
	const toggleScope = useCallback(
		(which) => {
			if (which === "notes") {
				if (showNotes && !showFolders) return;
				setShowNotes((v) => !v);
			} else {
				if (showFolders && !showNotes) return;
				setShowFolders((v) => !v);
			}
		},
		[showNotes, showFolders],
	);

	const [contextTarget, setContextTarget] = useState(null);
	const [pendingDeleteId, setPendingDeleteId] = useState(null);
	// Rename dialog target: { type: "file"|"folder", id?, path?, value }
	const [renameTarget, setRenameTarget] = useState(null);
	// New-folder dialog target: { parent, value }
	const [createFolderTarget, setCreateFolderTarget] = useState(null);
	// "+ New" dropdown (choose note vs folder, like the explorer's context menu).
	const [newMenuOpen, setNewMenuOpen] = useState(false);
	const newMenuRef = useRef(null);

	// Drag-and-drop move state. `dragItem` is the note/folder being dragged,
	// `dragOverPath` is the folder row currently hovered as a drop target.
	const [dragItem, setDragItem] = useState(null);
	const [dragOverPath, setDragOverPath] = useState(null);

	const createMutation = useCreateNote();
	const deleteMutation = useDeleteNote();
	const updateMutation = useUpdateNote();
	const renameFolderMutation = useRenameFolder();
	const removeNote = useNotesWorkspaceStore((s) => s.removeNote);
	const pinTab = useNotesWorkspaceStore((s) => s.pinTab);

	// Manual refresh of the notes tree: re-fetch every notes query (list, folder
	// browse, folders, tags). `refreshing` drives the spinning icon.
	const queryClient = useQueryClient();
	const [refreshing, setRefreshing] = useState(false);
	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await queryClient.invalidateQueries({ queryKey: notesKeys.all });
		} finally {
			setRefreshing(false);
		}
	}, [queryClient]);

	// Double-clicking a file opens it as a PERMANENT tab (no italic), VSCode-style.
	// Single-click still opens it in preview mode (via onSelectNote → the editor's
	// openTab). We navigate first, then pin: pinTab seeds a permanent tab even
	// before the editor has registered it, so the open-state sticks.
	// Selecting a note clears any folder highlight — the tree only ever shows a
	// single active row (folder OR note), never both.
	const handleSelectNote = useCallback(
		(id) => {
			setSelectedFolderPath(null);
			onSelectNote(id);
		},
		[onSelectNote],
	);

	const handleOpenPermanent = useCallback(
		(id, file) => {
			handleSelectNote(id);
			pinTab(id, { title: file?.title });
		},
		[handleSelectNote, pinTab],
	);

	const { data: rootCached, isLoading: isRootLoading } = useBrowseFolder("/");
	const { data: searchResults, isLoading: isSearchLoading } = useNotes(
		{ search: debouncedSearch },
		{ enabled: !!debouncedSearch && showNotes },
	);
	const { data: folderMatches, isLoading: isFolderSearchLoading } =
		useSearchFolders(debouncedSearch, 20, {
			enabled: !!debouncedSearch && showFolders,
		});
	const { data: selectedNote } = useNote(selectedNoteId);

	// "+ New" creates alongside the current selection: inside the selected
	// folder, or in the selected note's own folder, falling back to root.
	const newNoteFolder = selectedFolderPath || selectedNote?.folder || "/";

	// Sync the tree to the open note: expand every ancestor folder so the
	// active file is visible, and scroll it into view once its row mounts.
	const selectedItemRef = useCallback((node) => {
		if (!node) return;
		requestAnimationFrame(() => {
			node.scrollIntoView({ behavior: "smooth", block: "nearest" });
		});
	}, []);

	// selectedNoteId is intentional: re-expand if the user collapsed a folder
	// then picked another note inside it (folder unchanged, id changed).
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		const folder = selectedNote?.folder;
		if (!folder || folder === "/") return;
		const parts = folder.split("/").filter(Boolean);
		if (parts.length === 0) return;
		const ancestors = [];
		let cur = "";
		for (const p of parts) {
			cur += `/${p}`;
			ancestors.push(cur);
		}
		setExpandedFolders((prev) => {
			let changed = false;
			const next = { ...prev };
			for (const p of ancestors) {
				if (!next[p]) {
					next[p] = true;
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [selectedNote?.folder, selectedNoteId]);

	const toggleFolder = useCallback((path) => {
		setExpandedFolders((prev) => ({
			...prev,
			[path]: !prev[path],
		}));
	}, []);

	const handleFolderMatchPress = useCallback((path) => {
		if (!path || path === "/") {
			setSearch("");
			setDebouncedSearch("");
			return;
		}
		const parts = path.split("/").filter(Boolean);
		const ancestors = [];
		let cur = "";
		for (const p of parts) {
			cur += `/${p}`;
			ancestors.push(cur);
		}
		setExpandedFolders((prev) => {
			const next = { ...prev };
			for (const a of ancestors) next[a] = true;
			return next;
		});
		setSearch("");
		setDebouncedSearch("");
	}, []);

	const handleSearchChange = useCallback((e) => {
		const val = e.target.value;
		setSearch(val);
		if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
		searchTimerRef.current = setTimeout(() => setDebouncedSearch(val), 600);
	}, []);

	useEffect(() => {
		const handleClick = () => setContextTarget(null);
		window.addEventListener("click", handleClick);
		return () => {
			window.removeEventListener("click", handleClick);
			if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
		};
	}, []);

	// Dismiss the "+ New" dropdown when clicking outside it.
	useEffect(() => {
		if (!newMenuOpen) return;
		const onDown = (e) => {
			if (newMenuRef.current && !newMenuRef.current.contains(e.target)) {
				setNewMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [newMenuOpen]);

	const handleDelete = useCallback(
		(noteId) => {
			deleteMutation.mutate(noteId, {
				onSuccess: () => {
					removeNote(noteId);
					if (selectedNoteId === noteId) onSelectNote(null);
				},
				onError: (err) =>
					alert(err?.response?.data?.error ?? "Failed to delete"),
			});
		},
		[deleteMutation, selectedNoteId, onSelectNote, removeNote],
	);

	const confirmDelete = useCallback(() => {
		if (pendingDeleteId != null) handleDelete(pendingDeleteId);
		setPendingDeleteId(null);
	}, [pendingDeleteId, handleDelete]);

	// Open the rename dialog from a context-menu target, prefilled with the
	// current name (note title, or the folder's last path segment).
	const requestRename = useCallback((target) => {
		if (target.type === "file") {
			setRenameTarget({
				type: "file",
				id: target.id,
				value: target.file?.title || "",
			});
		} else {
			setRenameTarget({
				type: "folder",
				path: target.path,
				value: folderLabel(target.path),
			});
		}
	}, []);

	const confirmRename = useCallback(() => {
		if (!renameTarget) return;
		const value = renameTarget.value.trim();
		if (!value) return;

		if (renameTarget.type === "file") {
			updateMutation.mutate({ id: renameTarget.id, title: value });
		} else {
			// Folder rename = swap the last path segment, keeping the parent.
			const parent = renameTarget.path.slice(
				0,
				renameTarget.path.lastIndexOf("/"),
			);
			const to = `${parent}/${value}`;
			if (to !== renameTarget.path) {
				renameFolderMutation.mutate(
					{ from: renameTarget.path, to },
					{
						onError: (err) =>
							alert(err?.response?.data?.error ?? "Failed to rename folder"),
					},
				);
			}
		}
		setRenameTarget(null);
	}, [renameTarget, updateMutation, renameFolderMutation]);

	const handleDragStartItem = useCallback((item) => {
		setDragItem(item);
	}, []);

	// Drop a dragged note/folder onto `targetFolder`. Notes get their `folder`
	// rewritten; folders move by rebasing their path under the target (keeping
	// the leaf name), which the bulk folder-rename endpoint handles.
	const handleDropOnFolder = useCallback(
		(targetFolder) => {
			const item = dragItem;
			setDragItem(null);
			setDragOverPath(null);
			if (!item) return;

			if (item.type === "file") {
				if (item.folder === targetFolder) return;
				updateMutation.mutate(
					{ id: item.id, folder: targetFolder },
					{
						onError: (err) =>
							alert(err?.response?.data?.error ?? "Failed to move note"),
					},
				);
				if (targetFolder !== "/") {
					setExpandedFolders((prev) => ({ ...prev, [targetFolder]: true }));
				}
			} else if (item.type === "folder") {
				const leaf = folderLabel(item.path);
				const to =
					targetFolder === "/" ? `/${leaf}` : `${targetFolder}/${leaf}`;
				// No-op (same parent) or moving a folder into itself/a descendant.
				if (
					to === item.path ||
					targetFolder === item.path ||
					targetFolder.startsWith(`${item.path}/`)
				) {
					return;
				}
				renameFolderMutation.mutate(
					{ from: item.path, to },
					{
						onError: (err) =>
							alert(err?.response?.data?.error ?? "Failed to move folder"),
					},
				);
				if (targetFolder !== "/") {
					setExpandedFolders((prev) => ({ ...prev, [targetFolder]: true }));
				}
			}
		},
		[dragItem, updateMutation, renameFolderMutation],
	);

	// Clear drag state whenever a drag gesture ends anywhere (incl. cancel/Esc
	// or a drop outside any folder target), so highlights don't get stuck.
	useEffect(() => {
		const onDragEnd = () => {
			setDragItem(null);
			setDragOverPath(null);
		};
		window.addEventListener("dragend", onDragEnd);
		return () => window.removeEventListener("dragend", onDragEnd);
	}, []);

	const handleCreateNote = useCallback(
		(folder) => {
			createMutation.mutate(
				{ title: "Untitled", content: " ", folder },
				{
					onSuccess: (data) => {
						handleSelectNote(data.id);
						// A note the user just created is permanent, not a preview —
						// it shouldn't get evicted the moment they open another file.
						pinTab(data.id, { title: "Untitled" });
						if (folder !== "/") {
							setExpandedFolders((prev) => ({ ...prev, [folder]: true }));
						}
					},
					onError: () => alert("Failed to create note"),
				},
			);
		},
		[createMutation, handleSelectNote, pinTab],
	);

	const handleCreateFolder = useCallback(() => {
		setCreateFolderTarget({ parent: contextTarget?.path ?? "/", value: "" });
		setContextTarget(null);
	}, [contextTarget]);

	// Folders are ephemeral, so a new folder is seeded with an "Untitled" note
	// at the new path (otherwise the folder wouldn't exist anywhere).
	const confirmCreateFolder = useCallback(() => {
		if (!createFolderTarget) return;
		const name = createFolderTarget.value.trim();
		if (!name) return;
		const parentPath =
			createFolderTarget.parent === "/" ? "" : createFolderTarget.parent;
		const fullPath = `${parentPath}/${name}`;
		handleCreateNote(fullPath);
		setCreateFolderTarget(null);
	}, [createFolderTarget, handleCreateNote]);

	const dedupedResults = Object.values(
		(searchResults?.data || []).reduce((acc, note) => {
			if (!acc[note.id]) acc[note.id] = { ...note, highlights: [] };
			if (note.headline) acc[note.id].highlights.push(note.headline);
			return acc;
		}, {}),
	);

	const isEmpty =
		rootCached?.files.length === 0 && rootCached?.subfolders.length === 0;

	return (
		<div className="notes-sidebar-container">
			{/* Header */}
			<div className="notes-sidebar-header">
				<div className="notes-sidebar-header-row">
					<h3 className="notes-sidebar-title">Notes</h3>
					<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<button
							type="button"
							className="notes-sidebar-refresh"
							onClick={handleRefresh}
							disabled={refreshing}
							title="Refresh notes"
							aria-label="Refresh notes"
						>
							<span
								className={`notes-refresh-icon${refreshing ? " spin" : ""}`}
								aria-hidden="true"
							>
								⟳
							</span>
						</button>
						<span className="notes-new-anchor" ref={newMenuRef}>
							<button
								type="button"
								className="pixel-btn primary"
								onClick={() => setNewMenuOpen((o) => !o)}
								aria-haspopup="menu"
								aria-expanded={newMenuOpen}
							>
								+ New
							</button>
							{newMenuOpen && (
								<div className="pixel-context-menu notes-new-menu" role="menu">
									<div
										className="pixel-context-item"
										onClick={() => {
											handleCreateNote(newNoteFolder);
											setNewMenuOpen(false);
										}}
									>
										New Note
									</div>
									<div
										className="pixel-context-item"
										onClick={() => {
											setCreateFolderTarget({
												parent: newNoteFolder,
												value: "",
											});
											setNewMenuOpen(false);
										}}
									>
										New Folder
									</div>
								</div>
							)}
						</span>
						{onClose ? (
							<button
								type="button"
								className="pixel-btn notes-sidebar-close"
								onClick={onClose}
								title="Close"
								aria-label="Close notes list"
							>
								×
							</button>
						) : null}
					</div>
				</div>
				<div style={{ position: "relative" }}>
					<input
						className="pixel-input"
						placeholder="Search notes..."
						value={search}
						onChange={handleSearchChange}
						style={{
							width: "100%",
							boxSizing: "border-box",
							paddingRight: search ? 32 : undefined,
						}}
					/>
					{search && (
						<button
							className="pixel-btn icon-only notes-search-clear"
							onClick={() => {
								setSearch("");
								setDebouncedSearch("");
								if (searchTimerRef.current)
									clearTimeout(searchTimerRef.current);
							}}
							title="Clear search"
						>
							×
						</button>
					)}
				</div>
			</div>

			{/* Body */}
			<div
				className="notes-sidebar-tree"
				onContextMenu={(e) => {
					if (e.target === e.currentTarget) {
						e.preventDefault();
						setContextTarget({
							type: "folder",
							path: "/",
							x: e.clientX,
							y: e.clientY,
						});
					}
				}}
			>
				{isRootLoading ? (
					<div className="notes-sidebar-status notes-sidebar-status-loading">
						<span
							className="ftree-dog-spinner"
							role="status"
							aria-label="Loading"
						>
							<span className="ftree-dog-face">🐶</span>
						</span>
						<span>fetching notes…</span>
					</div>
				) : isEmpty ? (
					<div className="notes-sidebar-status notes-sidebar-status-empty">
						No notes found
					</div>
				) : debouncedSearch ? (
					<div className="ftree-search-wrapper">
						<div className="ftree-banner">
							<span className="ftree-banner-text">~/search ▒▒</span>
							<span className="ftree-banner-hint">
								{isSearchLoading || isFolderSearchLoading
									? "..."
									: `${dedupedResults.length} result${dedupedResults.length === 1 ? "" : "s"}`}
							</span>
						</div>
						<div className="scope-row">
							<button
								type="button"
								onClick={() => toggleScope("notes")}
								className={`scope-pill ${showNotes ? "on" : ""}`}
							>
								{showNotes ? "[x]" : "[ ]"} Notes
							</button>
							<button
								type="button"
								onClick={() => toggleScope("folders")}
								className={`scope-pill ${showFolders ? "on" : ""}`}
							>
								{showFolders ? "[x]" : "[ ]"} Folders
							</button>
						</div>
						{showFolders && folderMatches?.length > 0 ? (
							<div className="folder-match-section">
								<div className="folder-match-label">
									Folders ({folderMatches.length})
								</div>
								{folderMatches.map((m) => (
									<button
										key={m.path}
										type="button"
										onClick={() => handleFolderMatchPress(m.path)}
										className="folder-match-row"
									>
										<span className="folder-match-toggle">[+]</span>
										<span className="folder-match-body">
											<span className="folder-match-leaf">
												{m.leaf}
												<span className="folder-match-slash">/</span>
											</span>
											{m.path !== `/${m.leaf}` ? (
												<span className="folder-match-path">{m.path}</span>
											) : null}
										</span>
										<span className="folder-match-count">{m.file_count}</span>
									</button>
								))}
							</div>
						) : null}
						{showNotes ? (
							isSearchLoading ? (
								<div className="notes-sidebar-status notes-sidebar-status-loading">
									<span
										className="ftree-dog-spinner"
										role="status"
										aria-label="Loading"
									>
										<span className="ftree-dog-face">🐶</span>
									</span>
									<span>fetching notes…</span>
								</div>
							) : dedupedResults.length === 0 &&
								(!showFolders || !folderMatches?.length) ? (
								<div className="notes-sidebar-status">
									No results for "{debouncedSearch}"
								</div>
							) : (
								dedupedResults.map((note) => (
									<SearchResultItem
										key={note.id}
										note={note}
										isSelected={selectedNoteId === note.id}
										onSelect={handleSelectNote}
										onOpenPermanent={handleOpenPermanent}
										onRequestDelete={setPendingDeleteId}
										onSetContextTarget={setContextTarget}
										searchQuery={debouncedSearch}
									/>
								))
							)
						) : !showFolders || !folderMatches?.length ? (
							<div className="notes-sidebar-status">
								No results for "{debouncedSearch}"
							</div>
						) : null}
					</div>
				) : (
					<div
						className={`ftree-root ${
							dragOverPath === "/" ? "drag-over-root" : ""
						}`}
						onDragOver={(e) => {
							// Only the root area itself (rows stop propagation) — lets you
							// drop notes/folders back to the top level.
							if (!dragItem) return;
							e.preventDefault();
							e.dataTransfer.dropEffect = "move";
							if (dragOverPath !== "/") setDragOverPath("/");
						}}
						onDrop={(e) => {
							e.preventDefault();
							handleDropOnFolder("/");
						}}
					>
						<div className="ftree-banner">
							<span className="ftree-banner-text">~/notes ▒▒</span>
							<span className="ftree-banner-hint">tree -L ∞</span>
						</div>
						<TreeFolder
							path="/"
							depth={0}
							selectedNoteId={selectedNoteId}
							onSelectNote={handleSelectNote}
							selectedFolderPath={selectedFolderPath}
							onSelectFolder={setSelectedFolderPath}
							onOpenPermanent={handleOpenPermanent}
							onRequestDelete={setPendingDeleteId}
							onSetContextTarget={setContextTarget}
							expandedFolders={expandedFolders}
							toggleFolder={toggleFolder}
							selectedItemRef={selectedItemRef}
							onDragStartItem={handleDragStartItem}
							onDropOnFolder={handleDropOnFolder}
							dragOverPath={dragOverPath}
							setDragOverPath={setDragOverPath}
							dragItem={dragItem}
							contextTarget={contextTarget}
						/>
					</div>
				)}
			</div>

			{contextTarget && (
				<div
					className="pixel-context-menu"
					style={{ top: contextTarget.y, left: contextTarget.x }}
					onClick={(e) => e.stopPropagation()}
				>
					{contextTarget.type === "file" ? (
						<>
							<div
								className="pixel-context-item"
								onClick={() => {
									handleSelectNote(contextTarget.id);
									setContextTarget(null);
								}}
							>
								Open
							</div>
							<div
								className="pixel-context-item"
								onClick={() => {
									requestRename(contextTarget);
									setContextTarget(null);
								}}
							>
								Rename
							</div>
							<div
								className="pixel-context-item danger"
								onClick={() => {
									setPendingDeleteId(contextTarget.id);
									setContextTarget(null);
								}}
							>
								Delete
							</div>
						</>
					) : (
						<>
							<div
								className="pixel-context-item"
								onClick={() => {
									handleCreateNote(contextTarget.path);
									setContextTarget(null);
								}}
							>
								New Note
							</div>
							<div className="pixel-context-item" onClick={handleCreateFolder}>
								New Folder
							</div>
							{contextTarget.path !== "/" ? (
								<div
									className="pixel-context-item"
									onClick={() => {
										requestRename(contextTarget);
										setContextTarget(null);
									}}
								>
									Rename
								</div>
							) : null}
						</>
					)}
				</div>
			)}

			<PvModal
				open={pendingDeleteId != null}
				title="Move to Trash"
				confirmText="Move to Trash"
				cancelText="Cancel"
				danger
				onConfirm={confirmDelete}
				onCancel={() => setPendingDeleteId(null)}
			>
				Move this note to the trash? You can restore it later from the Trash
				page in the admin panel.
			</PvModal>

			<PvModal
				open={renameTarget != null}
				title={
					renameTarget?.type === "folder" ? "Rename Folder" : "Rename Note"
				}
				confirmText="Rename"
				cancelText="Cancel"
				onConfirm={confirmRename}
				onCancel={() => setRenameTarget(null)}
			>
				<label
					htmlFor="note-rename-input"
					style={{ display: "block", marginBottom: 6, fontSize: 12 }}
				>
					{renameTarget?.type === "folder"
						? "New folder name (renames every note inside it)"
						: "New note title"}
				</label>
				<input
					id="note-rename-input"
					className="pixel-input"
					style={{ width: "100%", boxSizing: "border-box" }}
					value={renameTarget?.value ?? ""}
					onChange={(e) =>
						setRenameTarget((prev) =>
							prev ? { ...prev, value: e.target.value } : prev,
						)
					}
				/>
			</PvModal>

			<PvModal
				open={createFolderTarget != null}
				title="New Folder"
				confirmText="Create"
				cancelText="Cancel"
				onConfirm={confirmCreateFolder}
				onCancel={() => setCreateFolderTarget(null)}
			>
				<label
					htmlFor="note-create-folder-input"
					style={{ display: "block", marginBottom: 6, fontSize: 12 }}
				>
					{`New folder name (created in ${createFolderTarget?.parent ?? "/"})`}
				</label>
				<input
					id="note-create-folder-input"
					className="pixel-input"
					style={{ width: "100%", boxSizing: "border-box" }}
					value={createFolderTarget?.value ?? ""}
					onChange={(e) =>
						setCreateFolderTarget((prev) =>
							prev ? { ...prev, value: e.target.value } : prev,
						)
					}
				/>
			</PvModal>
		</div>
	);
}
