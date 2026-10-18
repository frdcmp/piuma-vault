import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import FtreeScene from "@/admin/components/notes/FtreeScene";
import {
	PvButton,
	PvField,
	PvIconButton,
	PvInput,
	PvMenu,
	PvModal,
} from "@/ui";
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
import { formatDateCompact } from "../../../utils/dateTime";
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
				// biome-ignore lint/suspicious/noArrayIndexKey: the index is the ancestor depth — the segment's identity; the list only ever changes as a whole
				key={`p${i}-${more ? "t" : "g"}`}
				className={more ? "ftree-trunk" : "ftree-gap"}
			>
				{more ? "│  " : "   "}
			</span>
		))}
		<span className="ftree-branch">{isLast ? "└─ " : "├─ "}</span>
	</span>
);

// Rows are focusable treeitems rather than <button>s: they're draggable and
// hold their own delete button. Enter / Space on the focused row = click
// (ignored when the key event comes from a child control).
const activateOnKey = (action) => (e) => {
	if (e.target !== e.currentTarget) return;
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		action();
	}
};

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
		role="treeitem"
		tabIndex={0}
		aria-selected={selected}
		aria-level={parentLines.length + 1}
		draggable
		onDragStart={(e) => {
			e.stopPropagation();
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", file.id);
			onDragStartItem({ type: "file", id: file.id, folder });
		}}
		onClick={() => onSelect(file.id)}
		onKeyDown={activateOnKey(() => onSelect(file.id))}
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
		<span className="ftree-date">{formatDateCompact(file.updated_at)}</span>
		<button
			type="button"
			className="ftree-delete"
			onClick={(e) => {
				e.stopPropagation();
				onRequestDelete(file.id);
			}}
			title="Delete note"
			aria-label="Delete note"
		>
			×
		</button>
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
					role="treeitem"
					tabIndex={0}
					aria-selected={isSelectedFolder}
					aria-expanded={expanded}
					aria-level={depth}
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
					onKeyDown={activateOnKey(() => {
						onSelectFolder(path);
						toggleFolder(path);
					})}
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
		// Key each match by its character offset in the title.
		let offset = 0;
		return text.split(regex).map((part) => {
			const at = offset;
			offset += part.length;
			return regex.test(part) ? (
				<b key={at} className="search-match-highlight">
					{part}
				</b>
			) : (
				part
			);
		});
	};

	// Search snippets come from Postgres `ts_headline`, which echoes the note
	// body verbatim. The backend now escapes it and re-adds only <b>…</b>
	// (see notes::handlers::render_headline); this strips anything else that
	// somehow reaches us, so the innerHTML below can never run markup.
	const safeHeadline = (h) => String(h ?? "").replace(/<(?!\/?b>)[^>]*>/g, "");

	// Deduped so each snippet can key on its own text.
	const highlights = [
		...new Set(
			note.highlights?.length > 0
				? note.highlights
				: note.headline
					? [note.headline]
					: [],
		),
	];

	return (
		<div
			className={`ftree-row ftree-search ${isSelected ? "selected" : ""}`}
			role="treeitem"
			tabIndex={0}
			aria-selected={isSelected}
			onClick={() => onSelect(note.id)}
			onKeyDown={activateOnKey(() => onSelect(note.id))}
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
				<span className="ftree-date">{formatDateCompact(note.updated_at)}</span>
				<button
					type="button"
					className="ftree-delete"
					onClick={(e) => {
						e.stopPropagation();
						onRequestDelete(note.id);
					}}
					title="Delete note"
					aria-label="Delete note"
				>
					×
				</button>
			</div>

			{note.folder && note.folder !== "/" && (
				<div className="ftree-search-path">📁 {note.folder}</div>
			)}

			{highlights.map((highlight) => (
				<div
					key={highlight}
					className="ftree-search-headline note-search-headline"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: ts_headline snippet, escaped server-side (notes::handlers::render_headline re-adds only <b>/</b>) and stripped of every other tag by safeHeadline above
					dangerouslySetInnerHTML={{ __html: safeHeadline(highlight) }}
				/>
			))}
		</div>
	);
};

export default function NotesListSidebar({
	selectedNoteId,
	onSelectNote,
	onClose,
	onCollapse,
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
	// "+ New" dropdown (choose note vs folder, like the explorer's context menu):
	// the menu's anchor point under the button, null while closed.
	const [newMenuAt, setNewMenuAt] = useState(null);

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

	useEffect(
		() => () => {
			if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
		},
		[],
	);

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
					<div className="notes-sidebar-actions">
						{onCollapse ? (
							<PvIconButton
								variant="ghost"
								icon="«"
								label="Collapse notes list"
								onClick={onCollapse}
							/>
						) : null}
						<PvIconButton
							variant="ghost"
							icon={
								<span
									className={`notes-refresh-icon${refreshing ? " spin" : ""}`}
								>
									⟳
								</span>
							}
							label="Refresh notes"
							onClick={handleRefresh}
							disabled={refreshing}
						/>
						<PvButton
							size="sm"
							variant="primary"
							onClick={(e) => {
								const r = e.currentTarget.getBoundingClientRect();
								setNewMenuAt({ x: r.left, y: r.bottom + 4 });
							}}
							aria-haspopup="menu"
							aria-expanded={newMenuAt != null}
						>
							+ New
						</PvButton>
						{onClose ? (
							<PvIconButton
								variant="danger"
								size="lg"
								icon="×"
								label="Close notes list"
								onClick={onClose}
							/>
						) : null}
					</div>
				</div>
				<PvInput
					size="sm"
					placeholder="Search notes..."
					value={search}
					onChange={handleSearchChange}
					suffix={
						search ? (
							<PvIconButton
								size="sm"
								variant="ghost"
								icon="×"
								label="Clear search"
								onClick={() => {
									setSearch("");
									setDebouncedSearch("");
									if (searchTimerRef.current)
										clearTimeout(searchTimerRef.current);
								}}
							/>
						) : null
					}
				/>
			</div>

			<PvMenu
				open={newMenuAt != null}
				x={newMenuAt?.x}
				y={newMenuAt?.y}
				onClose={() => setNewMenuAt(null)}
				items={[
					{
						label: "New Note",
						onClick: () => handleCreateNote(newNoteFolder),
					},
					{
						label: "New Folder",
						onClick: () =>
							setCreateFolderTarget({ parent: newNoteFolder, value: "" }),
					},
				]}
			/>

			{/* Body */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only shortcut — right-clicking empty space opens the root-folder menu, whose actions (new note / new folder) are also on the "+ New" button */}
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
								<div role="tree" aria-label="Search results">
									{dedupedResults.map((note) => (
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
									))}
								</div>
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
						role="tree"
						aria-label="Notes"
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

			{!isRootLoading && !debouncedSearch && <FtreeScene />}

			<PvMenu
				open={contextTarget != null}
				x={contextTarget?.x}
				y={contextTarget?.y}
				onClose={() => setContextTarget(null)}
				items={
					contextTarget?.type === "file"
						? [
								{
									label: "Open",
									onClick: () => handleSelectNote(contextTarget.id),
								},
								{
									label: "Rename",
									onClick: () => requestRename(contextTarget),
								},
								{
									label: "Delete",
									danger: true,
									onClick: () => setPendingDeleteId(contextTarget.id),
								},
							]
						: [
								{
									label: "New Note",
									onClick: () => handleCreateNote(contextTarget?.path),
								},
								{ label: "New Folder", onClick: handleCreateFolder },
								...(contextTarget?.path !== "/"
									? [
											{
												label: "Rename",
												onClick: () => requestRename(contextTarget),
											},
										]
									: []),
							]
				}
			/>

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
				<PvField
					label={
						renameTarget?.type === "folder"
							? "New folder name (renames every note inside it)"
							: "New note title"
					}
				>
					<PvInput
						value={renameTarget?.value ?? ""}
						onChange={(e) =>
							setRenameTarget((prev) =>
								prev ? { ...prev, value: e.target.value } : prev,
							)
						}
					/>
				</PvField>
			</PvModal>

			<PvModal
				open={createFolderTarget != null}
				title="New Folder"
				confirmText="Create"
				cancelText="Cancel"
				onConfirm={confirmCreateFolder}
				onCancel={() => setCreateFolderTarget(null)}
			>
				<PvField
					label={`New folder name (created in ${createFolderTarget?.parent ?? "/"})`}
				>
					<PvInput
						value={createFolderTarget?.value ?? ""}
						onChange={(e) =>
							setCreateFolderTarget((prev) =>
								prev ? { ...prev, value: e.target.value } : prev,
							)
						}
					/>
				</PvField>
			</PvModal>
		</div>
	);
}
