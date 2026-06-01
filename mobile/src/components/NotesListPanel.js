import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	FlatList,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";

const MONO = Platform.select({
	ios: "Menlo",
	android: "monospace",
	default: "monospace",
});

import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
	browseFolder,
	createNote,
	deleteNote,
	fetchFolders,
	fetchNote,
	fetchNotes,
	renameFolder,
	searchFolders,
	updateNote,
} from "../api/notesApi";
import { notesKeys } from "../queries/notesQuery";
import { formatDate } from "../utils/dateTime";
import { colors } from "../utils/theme";
import BottomSheet, { BottomSheetItem } from "./BottomSheet";
import PiumaRunning from "./PiumaRunning";
import { BottomBar, useTopInset } from "./SystemBars";

function useDebounced(value, delay = 300) {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const id = setTimeout(() => setDebounced(value), delay);
		return () => clearTimeout(id);
	}, [value, delay]);
	return debounced;
}

const folderLabel = (path) => {
	if (!path || path === "/") return "/";
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] || "/";
};

// Light markdown sweep so search snippets don't render `**bold**`, table
// pipes, headings, code fences, etc. as raw text. We deliberately keep this
// simple — anything more clever risks chewing real text.
function stripMarkdown(text) {
	if (!text) return "";
	return text
		.replace(/\*\*/g, "")
		.replace(/__/g, "")
		.replace(/`+/g, "")
		.replace(/^#+\s*/gm, "")
		.replace(/\|+/g, " · ")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// Convert server-side highlight HTML into segments. ts_headline wraps whole
// matched lexemes ("<b>user</b>" for query "france"), but we only want
// to visually highlight what the user actually typed — so we strip the <b>
// markers, clean markdown, then re-highlight the plain text against the
// query so the highlight matches the user's input exactly.
function parseHighlight(html, query) {
	if (!html) return [];
	const plain = stripMarkdown(html.replace(/<\/?b>/g, ""));
	if (!plain) return [];
	return highlightText(plain, query);
}

// Splits plain text into segments at each (case-insensitive) occurrence of
// `query`. Used to highlight matches inside the note title.
function highlightText(text, query) {
	if (!query || !text) return [{ text: text || "", match: false }];
	const re = new RegExp(
		`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
		"gi",
	);
	const out = [];
	let last = 0;
	for (const m of text.matchAll(re)) {
		if (m.index > last)
			out.push({ text: text.slice(last, m.index), match: false });
		out.push({ text: m[0], match: true });
		last = m.index + m[0].length;
	}
	if (last < text.length) out.push({ text: text.slice(last), match: false });
	return out;
}

// Renders a `tree`-command-style ASCII prefix as a list of <Text> segments.
// Vertical `│` trunks are tinted in `treeTrunk` color so each expanded
// folder visibly connects down to its children; corner chars stay muted.
// `parentLines[i]` true ⇒ ancestor at depth i still has more siblings.
function renderTreePrefix(parentLines, isLast) {
	const out = [];
	parentLines.forEach((more, i) => {
		out.push(
			<Text
				key={`d${i}${more ? "T" : "G"}`}
				style={more ? styles.treeTrunk : null}
			>
				{more ? "│  " : "   "}
			</Text>,
		);
	});
	out.push(
		<Text key="leaf" style={styles.treeBranch}>
			{isLast ? "└─ " : "├─ "}
		</Text>,
	);
	return out;
}

function FolderNode({
	path,
	depth,
	parentLines = [],
	isLast = false,
	selectedId,
	onOpenNote,
	onContext,
	expandedFolders,
	setExpandedFolders,
}) {
	// Root is always expanded; deeper folders are controlled by the parent
	// panel so opening a note can sync the tree open to its ancestors.
	const expanded = depth === 0 || !!expandedFolders[path];
	const toggleExpanded = () =>
		setExpandedFolders((prev) => ({ ...prev, [path]: !prev[path] }));
	const { data, isLoading } = useQuery({
		queryKey: notesKeys.browse(path),
		queryFn: () => browseFolder(path),
		enabled: expanded,
		staleTime: 30_000,
	});

	const subfolders = data?.subfolders || [];
	const files = data?.files || [];
	const childCount = subfolders.length + files.length;
	const childParentLines = depth > 0 ? [...parentLines, !isLast] : parentLines;

	return (
		<View>
			{depth > 0 && (
				<TouchableOpacity
					style={styles.folderRow}
					onPress={toggleExpanded}
					onLongPress={() => onContext({ type: "folder", path })}
					delayLongPress={300}
				>
					<Text style={styles.treePrefix}>
						{renderTreePrefix(parentLines, isLast)}
					</Text>
					<Text style={styles.folderToggle}>{expanded ? "[-]" : "[+]"}</Text>
					<Text style={styles.folderName} numberOfLines={1}>
						{" "}
						{folderLabel(path)}
						<Text style={styles.folderSlash}>/</Text>
					</Text>
					{expanded && childCount > 0 ? (
						<Text style={styles.folderCount}>{childCount}</Text>
					) : null}
				</TouchableOpacity>
			)}
			{expanded && (
				<View>
					{isLoading && (
						<View style={styles.loaderRow}>
							<Text style={styles.treePrefix}>
								{renderTreePrefix(childParentLines, true)}
							</Text>
							<ActivityIndicator color={colors.accent} size="small" />
						</View>
					)}
					{subfolders.map((sub, idx) => {
						const subPath = path === "/" ? `/${sub}` : `${path}/${sub}`;
						const isLastChild =
							idx === subfolders.length - 1 && files.length === 0;
						return (
							<FolderNode
								key={subPath}
								path={subPath}
								depth={depth + 1}
								parentLines={childParentLines}
								isLast={isLastChild}
								selectedId={selectedId}
								onOpenNote={onOpenNote}
								onContext={onContext}
								expandedFolders={expandedFolders}
								setExpandedFolders={setExpandedFolders}
							/>
						);
					})}
					{files.map((note, idx) => {
						const isLastChild = idx === files.length - 1;
						return (
							<NoteRow
								key={note.id}
								note={note}
								parentLines={childParentLines}
								isLast={isLastChild}
								selected={selectedId === note.id}
								onPress={() => onOpenNote(note.id)}
								onContext={() =>
									onContext({
										type: "note",
										note: { ...note, folder: note.folder ?? path },
									})
								}
							/>
						);
					})}
					{!isLoading && childCount === 0 && depth > 0 && (
						<View style={styles.emptyRow}>
							<Text style={styles.treePrefix}>
								{renderTreePrefix(childParentLines, true)}
							</Text>
							<Text style={styles.emptyHint}>(empty)</Text>
						</View>
					)}
				</View>
			)}
		</View>
	);
}

function NoteRow({
	note,
	parentLines,
	isLast = false,
	selected,
	onPress,
	onContext,
	searchQuery,
	highlights,
	loading = false,
}) {
	const isSearchResult = Array.isArray(highlights) && highlights.length > 0;
	const titleSegs = isSearchResult
		? highlightText(note.title || "Untitled", searchQuery)
		: null;
	const showFolder = isSearchResult && note.folder && note.folder !== "/";
	const inTree = Array.isArray(parentLines);

	return (
		<Pressable
			onPress={onPress}
			onLongPress={onContext}
			delayLongPress={300}
			style={[
				styles.noteRow,
				isSearchResult && styles.noteRowSearch,
				selected && styles.noteRowSelected,
				loading && styles.rowDim,
			]}
		>
			<View style={styles.noteRowTop}>
				{inTree ? (
					<Text style={styles.treePrefix}>
						{renderTreePrefix(parentLines, isLast)}
					</Text>
				) : null}
				{loading ? (
					<View style={styles.miniDogBox}>
						<PiumaRunning pixelSize={1} />
					</View>
				) : (
					<Text
						style={[styles.noteBullet, selected && styles.noteBulletSelected]}
					>
						{selected ? "▶" : "▸"}
					</Text>
				)}
				<Text
					style={[styles.noteTitle, selected && styles.noteTitleSelected]}
					numberOfLines={1}
				>
					{titleSegs
						? titleSegs.map((s, i) => (
								<Text
									key={`t${i}-${s.text}`}
									style={s.match ? styles.match : null}
								>
									{s.text}
								</Text>
							))
						: note.title || "Untitled"}
				</Text>
				<Text style={styles.noteDate}>{formatDate(note.updated_at)}</Text>
			</View>
			{showFolder ? (
				<Text style={styles.notePath} numberOfLines={1}>
					📁 {note.folder}
				</Text>
			) : null}
			{isSearchResult
				? highlights.map((h, i) => {
						const segs = parseHighlight(h, searchQuery);
						if (segs.length === 0) return null;
						return (
							<Text
								key={`h${i}-${h.length}`}
								style={styles.headline}
								numberOfLines={2}
							>
								{segs.map((s, j) => (
									<Text
										key={`s${j}-${s.text}`}
										style={s.match ? styles.match : null}
									>
										{s.text}
									</Text>
								))}
							</Text>
						);
					})
				: null}
		</Pressable>
	);
}

export default function NotesListPanel({
	selectedNoteId,
	onSelectNote,
	onNewNote,
}) {
	const queryClient = useQueryClient();
	const insets = useSafeAreaInsets();
	const topInset = useTopInset();

	const [searchInput, setSearchInput] = useState("");
	const search = useDebounced(searchInput.trim(), 350);
	const [expandedFolders, setExpandedFolders] = useState({});
	const [showNotes, setShowNotes] = useState(true);
	const [showFolders, setShowFolders] = useState(true);

	// Toggle a scope, but keep at least one enabled — turning off the last one
	// would leave the user with empty results and no obvious way to recover.
	const toggleScope = (which) => {
		if (which === "notes") {
			if (showNotes && !showFolders) return;
			setShowNotes((v) => !v);
		} else {
			if (showFolders && !showNotes) return;
			setShowFolders((v) => !v);
		}
	};

	const searchQuery = useQuery({
		queryKey: notesKeys.list({ search }),
		queryFn: () => fetchNotes({ search, limit: 50 }),
		enabled: search.length > 0 && showNotes,
		keepPreviousData: true,
	});

	const folderSearchQuery = useQuery({
		queryKey: ["notes", "folders", "search", search],
		queryFn: () => searchFolders(search, 20),
		enabled: search.length > 0 && showFolders,
		keepPreviousData: true,
		staleTime: 30_000,
	});

	const expandToFolder = (path) => {
		if (!path || path === "/") return;
		const parts = path.split("/").filter(Boolean);
		const ancestors = [];
		let cur = "";
		for (const p of parts) {
			cur += `/${p}`;
			ancestors.push(cur);
		}
		setExpandedFolders((prev) => {
			const next = { ...prev };
			for (const p of ancestors) next[p] = true;
			return next;
		});
	};

	const handleFolderMatchPress = (path) => {
		expandToFolder(path);
		setSearchInput("");
	};

	// Look up the open note so we can expand its ancestor folders in the tree.
	const noteDetailQuery = useQuery({
		queryKey: notesKeys.detail(selectedNoteId),
		queryFn: () => fetchNote(selectedNoteId),
		enabled: !!selectedNoteId,
		staleTime: 30_000,
	});
	const selectedFolder = noteDetailQuery.data?.folder;

	useEffect(() => {
		if (!selectedFolder || selectedFolder === "/") return;
		const parts = selectedFolder.split("/").filter(Boolean);
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
	}, [selectedFolder, selectedNoteId]);

	// ── Long-press context menu (mirrors the web sidebar's right-click menu) ──
	const [contextTarget, setContextTarget] = useState(null);
	const [renameTarget, setRenameTarget] = useState(null);
	const [renameValue, setRenameValue] = useState("");
	const [newFolderParent, setNewFolderParent] = useState(null);
	const [newFolderValue, setNewFolderValue] = useState("");
	const [pendingDelete, setPendingDelete] = useState(null);
	const [moveTarget, setMoveTarget] = useState(null);

	const openContext = (target) => setContextTarget(target);
	const closeContext = () => setContextTarget(null);

	// A menu item that opens a follow-up modal must wait for the sheet to finish
	// closing first — RN can't show two modals at once. Items stash their action
	// here; BottomSheet's onClosed runs it once the sheet is gone.
	const pendingActionRef = useRef(null);
	const runAfterClose = (fn) => {
		pendingActionRef.current = fn;
	};
	const handleSheetClosed = () => {
		const fn = pendingActionRef.current;
		pendingActionRef.current = null;
		fn?.();
	};

	const invalidateNotes = () =>
		queryClient.invalidateQueries({ queryKey: notesKeys.all });

	const delMutation = useMutation({
		mutationFn: (id) => deleteNote(id),
		onSuccess: invalidateNotes,
		onError: (e) =>
			Alert.alert("Delete failed", e.response?.data?.message || e.message),
	});

	const createMutation = useMutation({
		mutationFn: (payload) => createNote(payload),
		onSuccess: (data) => {
			invalidateNotes();
			if (data?.folder && data.folder !== "/") {
				setExpandedFolders((prev) => ({ ...prev, [data.folder]: true }));
			}
			if (data?.id) onSelectNote(data.id);
		},
		onError: (e) =>
			Alert.alert("Create failed", e.response?.data?.message || e.message),
	});

	const renameNoteMutation = useMutation({
		mutationFn: ({ id, title }) => updateNote({ id, title }),
		onSuccess: invalidateNotes,
		onError: (e) =>
			Alert.alert("Rename failed", e.response?.data?.message || e.message),
	});

	const renameFolderMutation = useMutation({
		mutationFn: ({ from, to }) => renameFolder({ from, to }),
		onSuccess: invalidateNotes,
		onError: (e) =>
			Alert.alert(
				"Rename failed",
				e.response?.data?.error || e.response?.data?.message || e.message,
			),
	});

	// Open the rename modal seeded with the current note title / folder leaf.
	const startRename = (t) => {
		if (!t) return;
		setRenameValue(
			t.type === "note" ? t.note.title || "" : folderLabel(t.path),
		);
		setRenameTarget(t);
	};

	const confirmRename = () => {
		const t = renameTarget;
		const value = renameValue.trim();
		setRenameTarget(null);
		if (!t || !value) return;
		if (t.type === "note") {
			renameNoteMutation.mutate({ id: t.note.id, title: value });
		} else {
			// Folder rename = swap the last path segment, keeping the parent.
			const parent = t.path.slice(0, t.path.lastIndexOf("/"));
			const to = `${parent}/${value}`;
			if (to !== t.path) renameFolderMutation.mutate({ from: t.path, to });
		}
	};

	const newNoteInFolder = (folder) =>
		createMutation.mutate({ title: "Untitled", content: " ", folder });

	const startNewFolder = (parent) => {
		setNewFolderValue("");
		setNewFolderParent(parent);
	};

	// Folders are virtual, so a new one is seeded with an "Untitled" note at the
	// new path (otherwise it wouldn't exist anywhere).
	const confirmNewFolder = () => {
		const parent = newFolderParent;
		const name = newFolderValue.trim();
		setNewFolderParent(null);
		if (parent == null || !name) return;
		const base = parent === "/" ? "" : parent;
		newNoteInFolder(`${base}/${name}`);
	};

	const confirmDelete = () => {
		const note = pendingDelete;
		setPendingDelete(null);
		if (note) delMutation.mutate(note.id);
	};

	// ── Move to… (mirrors the web drag-and-drop) ─────────────────────────────
	const moveNoteMutation = useMutation({
		mutationFn: ({ id, folder }) => updateNote({ id, folder }),
		onSuccess: invalidateNotes,
		onError: (e) =>
			Alert.alert("Move failed", e.response?.data?.message || e.message),
	});

	const foldersQuery = useQuery({
		queryKey: ["notes", "folders", "all"],
		queryFn: fetchFolders,
		enabled: !!moveTarget,
		staleTime: 30_000,
	});

	// fetchFolders returns only folders that directly contain notes, so derive
	// every ancestor too (plus root) for a complete destination list.
	const moveDestinations = useMemo(() => {
		const set = new Set(["/"]);
		for (const f of foldersQuery.data || []) {
			const parts = f.split("/").filter(Boolean);
			let cur = "";
			for (const p of parts) {
				cur += `/${p}`;
				set.add(cur);
			}
		}
		return [...set].sort();
	}, [foldersQuery.data]);

	// A destination is invalid if it's a no-op or would move a folder into
	// itself / one of its own descendants.
	const isValidDest = (dest) => {
		const t = moveTarget;
		if (!t) return false;
		if (t.type === "note") return dest !== (t.note.folder || "/");
		const leaf = folderLabel(t.path);
		const to = dest === "/" ? `/${leaf}` : `${dest}/${leaf}`;
		return to !== t.path && dest !== t.path && !dest.startsWith(`${t.path}/`);
	};

	const startMove = (t) => setMoveTarget(t);

	const doMove = (dest) => {
		const t = moveTarget;
		setMoveTarget(null);
		if (!t) return;
		if (t.type === "note") {
			moveNoteMutation.mutate({ id: t.note.id, folder: dest });
		} else {
			const leaf = folderLabel(t.path);
			const to = dest === "/" ? `/${leaf}` : `${dest}/${leaf}`;
			renameFolderMutation.mutate({ from: t.path, to });
		}
		if (dest !== "/") setExpandedFolders((prev) => ({ ...prev, [dest]: true }));
	};

	const searchResults = useMemo(
		() => searchQuery.data?.data || [],
		[searchQuery.data],
	);
	const folderMatches = useMemo(
		() => (Array.isArray(folderSearchQuery.data) ? folderSearchQuery.data : []),
		[folderSearchQuery.data],
	);
	const anyLoading =
		(showNotes && searchQuery.isFetching) ||
		(showFolders && folderSearchQuery.isFetching);

	return (
		<View style={[styles.container, { paddingTop: topInset }]}>
			<View style={styles.header}>
				<Text style={styles.headerTitle}>Notes</Text>
				<View style={styles.headerActions}>
					<TouchableOpacity onPress={onNewNote} style={styles.newBtn}>
						<Text style={styles.newBtnText}>+ New</Text>
					</TouchableOpacity>
				</View>
			</View>

			<View style={styles.searchContainer}>
				<Ionicons
					name="search"
					size={18}
					color={colors.muted}
					style={{ marginRight: 8 }}
				/>
				<TextInput
					style={styles.searchInput}
					placeholder="Search notes..."
					placeholderTextColor={colors.muted}
					value={searchInput}
					onChangeText={setSearchInput}
					autoCapitalize="none"
					autoCorrect={false}
				/>
				{searchInput.length > 0 && (
					<TouchableOpacity onPress={() => setSearchInput("")}>
						<Ionicons name="close-circle" size={18} color={colors.muted} />
					</TouchableOpacity>
				)}
			</View>

			{search.length > 0 ? (
				<View style={styles.scopeRow}>
					<Pressable
						onPress={() => toggleScope("notes")}
						style={[styles.scopePill, showNotes && styles.scopePillOn]}
					>
						<Text
							style={[
								styles.scopePillText,
								showNotes && styles.scopePillTextOn,
							]}
						>
							{showNotes ? "[x]" : "[ ]"} Notes
						</Text>
					</Pressable>
					<Pressable
						onPress={() => toggleScope("folders")}
						style={[styles.scopePill, showFolders && styles.scopePillOn]}
					>
						<Text
							style={[
								styles.scopePillText,
								showFolders && styles.scopePillTextOn,
							]}
						>
							{showFolders ? "[x]" : "[ ]"} Folders
						</Text>
					</Pressable>
				</View>
			) : null}

			{search.length > 0 ? (
				<FlatList
					data={showNotes ? searchResults : []}
					keyExtractor={(n) => n.id}
					contentContainerStyle={[
						styles.listContent,
						{ paddingBottom: 24 + insets.bottom },
					]}
					renderItem={({ item }) => (
						<NoteRow
							note={item}
							searchQuery={search}
							highlights={
								item.highlights?.length
									? item.highlights
									: item.headline
										? [item.headline]
										: []
							}
							selected={selectedNoteId === item.id}
							onPress={() => onSelectNote(item.id)}
							onContext={() => openContext({ type: "note", note: item })}
							loading={anyLoading}
						/>
					)}
					ListHeaderComponent={
						<View>
							{searchQuery.isFetching || folderSearchQuery.isFetching ? (
								<View style={styles.searchLoader}>
									<PiumaRunning pixelSize={6} />
									<Text style={styles.searchLoaderText}>fetching...</Text>
								</View>
							) : null}
							{showFolders && folderMatches.length > 0 ? (
								<View style={styles.folderMatchSection}>
									<Text style={styles.sectionLabel}>
										Folders ({folderMatches.length})
									</Text>
									{folderMatches.map((m) => (
										<Pressable
											key={m.path}
											onPress={() => handleFolderMatchPress(m.path)}
											onLongPress={() =>
												openContext({ type: "folder", path: m.path })
											}
											delayLongPress={300}
											style={({ pressed }) => [
												styles.folderMatchRow,
												pressed && styles.folderMatchRowPressed,
												anyLoading && styles.rowDim,
											]}
										>
											{anyLoading ? (
												<View style={styles.miniDogBox}>
													<PiumaRunning pixelSize={1} />
												</View>
											) : (
												<Text style={styles.folderMatchToggle}>[+]</Text>
											)}
											<View style={{ flex: 1 }}>
												<Text style={styles.folderMatchLeaf} numberOfLines={1}>
													{m.leaf}
													<Text style={styles.folderSlash}>/</Text>
												</Text>
												{m.path !== `/${m.leaf}` ? (
													<Text
														style={styles.folderMatchPath}
														numberOfLines={1}
													>
														{m.path}
													</Text>
												) : null}
											</View>
											<Text style={styles.folderMatchCount}>
												{m.file_count}
											</Text>
										</Pressable>
									))}
								</View>
							) : null}
							{showNotes && !searchQuery.isFetching ? (
								<Text style={styles.resultCount}>
									{searchResults.length} note
									{searchResults.length === 1 ? "" : "s"}
								</Text>
							) : null}
						</View>
					}
					ListEmptyComponent={
						!searchQuery.isFetching &&
						!folderSearchQuery.isFetching &&
						(!showNotes || searchResults.length === 0) &&
						(!showFolders || folderMatches.length === 0) ? (
							<Text style={styles.emptyText}>No matches.</Text>
						) : null
					}
				/>
			) : (
				<FlatList
					data={[null]}
					keyExtractor={() => "tree"}
					contentContainerStyle={[
						styles.listContent,
						{ paddingBottom: 24 + insets.bottom },
					]}
					renderItem={() => (
						<View style={styles.treeRoot}>
							<Pressable
								style={styles.treeBanner}
								onLongPress={() => openContext({ type: "folder", path: "/" })}
								delayLongPress={300}
							>
								<Text style={styles.treeBannerText}>~/notes ▒▒</Text>
								<Text style={styles.treeBannerHint}>tree -L ∞</Text>
							</Pressable>
							<FolderNode
								path="/"
								depth={0}
								selectedId={selectedNoteId}
								onOpenNote={onSelectNote}
								onContext={openContext}
								expandedFolders={expandedFolders}
								setExpandedFolders={setExpandedFolders}
							/>
						</View>
					)}
				/>
			)}

			{/* Long-press context menu — mirrors the web sidebar's right-click menu */}
			<BottomSheet
				visible={!!contextTarget}
				onClose={closeContext}
				onClosed={handleSheetClosed}
				title={
					contextTarget
						? contextTarget.type === "note"
							? contextTarget.note.title || "Untitled"
							: `${folderLabel(contextTarget.path)}/`
						: ""
				}
			>
				{contextTarget?.type === "note" ? (
					<>
						<BottomSheetItem
							icon="open-outline"
							label="Open"
							color={colors.accent2}
							onPress={() => onSelectNote(contextTarget.note.id)}
						/>
						<BottomSheetItem
							icon="create-outline"
							label="Rename"
							onPress={() => {
								const t = contextTarget;
								runAfterClose(() => startRename(t));
							}}
						/>
						<BottomSheetItem
							icon="arrow-redo-outline"
							label="Move to…"
							onPress={() => {
								const t = contextTarget;
								runAfterClose(() => startMove(t));
							}}
						/>
						<BottomSheetItem
							icon="trash-outline"
							label="Delete"
							color={colors.accent3}
							onPress={() => {
								const note = contextTarget.note;
								runAfterClose(() => setPendingDelete(note));
							}}
						/>
					</>
				) : contextTarget?.type === "folder" ? (
					<>
						<BottomSheetItem
							icon="document-outline"
							label="New Note"
							color={colors.accent2}
							onPress={() => newNoteInFolder(contextTarget.path)}
						/>
						<BottomSheetItem
							icon="folder-outline"
							label="New Folder"
							onPress={() => {
								const path = contextTarget.path;
								runAfterClose(() => startNewFolder(path));
							}}
						/>
						{contextTarget.path !== "/" ? (
							<BottomSheetItem
								icon="create-outline"
								label="Rename"
								onPress={() => {
									const t = contextTarget;
									runAfterClose(() => startRename(t));
								}}
							/>
						) : null}
						{contextTarget.path !== "/" ? (
							<BottomSheetItem
								icon="arrow-redo-outline"
								label="Move to…"
								onPress={() => {
									const t = contextTarget;
									runAfterClose(() => startMove(t));
								}}
							/>
						) : null}
					</>
				) : null}
			</BottomSheet>

			{/* Rename note / folder */}
			<Modal
				visible={!!renameTarget}
				transparent
				animationType="fade"
				onRequestClose={() => setRenameTarget(null)}
			>
				<Pressable
					style={styles.modalOverlay}
					onPress={() => setRenameTarget(null)}
				>
					<Pressable style={styles.modalCard} onPress={() => {}}>
						<Text style={styles.modalTitle}>
							{renameTarget?.type === "folder"
								? "Rename folder"
								: "Rename note"}
						</Text>
						<TextInput
							style={styles.modalInput}
							value={renameValue}
							onChangeText={setRenameValue}
							placeholder={
								renameTarget?.type === "folder" ? "folder-name" : "Title"
							}
							placeholderTextColor={colors.muted}
							autoFocus
							autoCapitalize="none"
							autoCorrect={false}
							onSubmitEditing={confirmRename}
						/>
						<View style={styles.modalActions}>
							<TouchableOpacity
								style={styles.modalBtn}
								onPress={() => setRenameTarget(null)}
							>
								<Text style={styles.modalBtnText}>Cancel</Text>
							</TouchableOpacity>
							<TouchableOpacity
								style={[styles.modalBtn, styles.modalBtnPrimary]}
								onPress={confirmRename}
							>
								<Text style={[styles.modalBtnText, styles.modalBtnTextPrimary]}>
									Rename
								</Text>
							</TouchableOpacity>
						</View>
					</Pressable>
				</Pressable>
				<BottomBar />
			</Modal>

			{/* New folder */}
			<Modal
				visible={newFolderParent != null}
				transparent
				animationType="fade"
				onRequestClose={() => setNewFolderParent(null)}
			>
				<Pressable
					style={styles.modalOverlay}
					onPress={() => setNewFolderParent(null)}
				>
					<Pressable style={styles.modalCard} onPress={() => {}}>
						<Text style={styles.modalTitle}>New folder</Text>
						<Text style={styles.modalHint}>
							Created under {newFolderParent || "/"}
						</Text>
						<TextInput
							style={styles.modalInput}
							value={newFolderValue}
							onChangeText={setNewFolderValue}
							placeholder="my-folder"
							placeholderTextColor={colors.muted}
							autoFocus
							autoCapitalize="none"
							autoCorrect={false}
							onSubmitEditing={confirmNewFolder}
						/>
						<View style={styles.modalActions}>
							<TouchableOpacity
								style={styles.modalBtn}
								onPress={() => setNewFolderParent(null)}
							>
								<Text style={styles.modalBtnText}>Cancel</Text>
							</TouchableOpacity>
							<TouchableOpacity
								style={[styles.modalBtn, styles.modalBtnPrimary]}
								onPress={confirmNewFolder}
							>
								<Text style={[styles.modalBtnText, styles.modalBtnTextPrimary]}>
									Create
								</Text>
							</TouchableOpacity>
						</View>
					</Pressable>
				</Pressable>
				<BottomBar />
			</Modal>

			{/* Delete confirmation */}
			<Modal
				visible={!!pendingDelete}
				transparent
				animationType="fade"
				onRequestClose={() => setPendingDelete(null)}
			>
				<Pressable
					style={styles.modalOverlay}
					onPress={() => setPendingDelete(null)}
				>
					<Pressable style={styles.modalCard} onPress={() => {}}>
						<Text style={styles.modalTitle}>Delete note</Text>
						<Text style={styles.modalHint} numberOfLines={3}>
							Permanently delete "{pendingDelete?.title || "Untitled"}"? This
							action cannot be undone.
						</Text>
						<View style={styles.modalActions}>
							<TouchableOpacity
								style={styles.modalBtn}
								onPress={() => setPendingDelete(null)}
							>
								<Text style={styles.modalBtnText}>Cancel</Text>
							</TouchableOpacity>
							<TouchableOpacity
								style={[styles.modalBtn, styles.modalBtnDanger]}
								onPress={confirmDelete}
							>
								<Text style={[styles.modalBtnText, styles.modalBtnTextDanger]}>
									Delete
								</Text>
							</TouchableOpacity>
						</View>
					</Pressable>
				</Pressable>
				<BottomBar />
			</Modal>

			{/* Move to… folder picker (mirrors the web drag-and-drop) */}
			<Modal
				visible={!!moveTarget}
				transparent
				animationType="fade"
				onRequestClose={() => setMoveTarget(null)}
			>
				<Pressable
					style={styles.modalOverlay}
					onPress={() => setMoveTarget(null)}
				>
					<Pressable style={styles.modalCard} onPress={() => {}}>
						<Text style={styles.modalTitle}>Move to…</Text>
						<Text style={styles.modalHint} numberOfLines={1}>
							{moveTarget?.type === "note"
								? `Note · from ${moveTarget.note.folder || "/"}`
								: `Folder · ${folderLabel(moveTarget?.path || "")}/`}
						</Text>
						{foldersQuery.isLoading ? (
							<ActivityIndicator
								color={colors.accent}
								style={{ marginVertical: 20 }}
							/>
						) : (
							<ScrollView
								style={styles.moveList}
								keyboardShouldPersistTaps="handled"
							>
								{moveDestinations.filter(isValidDest).map((dest) => (
									<TouchableOpacity
										key={dest}
										style={styles.moveRow}
										onPress={() => doMove(dest)}
									>
										<Ionicons
											name={dest === "/" ? "home-outline" : "folder-outline"}
											size={16}
											color={colors.accent2}
										/>
										<Text style={styles.moveRowText} numberOfLines={1}>
											{dest}
										</Text>
									</TouchableOpacity>
								))}
								{moveDestinations.filter(isValidDest).length === 0 ? (
									<Text style={styles.emptyHint}>
										No available destinations.
									</Text>
								) : null}
							</ScrollView>
						)}
						<View style={styles.modalActions}>
							<TouchableOpacity
								style={styles.modalBtn}
								onPress={() => setMoveTarget(null)}
							>
								<Text style={styles.modalBtnText}>Cancel</Text>
							</TouchableOpacity>
						</View>
					</Pressable>
				</Pressable>
				<BottomBar />
			</Modal>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: colors.bg },
	header: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		paddingHorizontal: 16,
		paddingTop: 12,
		paddingBottom: 12,
		borderBottomWidth: 2,
		borderBottomColor: colors.borderStrong,
		borderStyle: "dashed",
		backgroundColor: colors.panel,
	},
	headerTitle: {
		fontSize: 18,
		fontWeight: "700",
		color: colors.accent,
		fontFamily: MONO,
		letterSpacing: 0.5,
	},
	headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
	newBtn: {
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.accent2,
		paddingHorizontal: 10,
		paddingVertical: 4,
		boxShadow: "2px 2px 0 #000",
	},
	newBtnText: {
		color: colors.accent2,
		fontWeight: "700",
		fontSize: 13,
		fontFamily: MONO,
	},
	iconBtn: {
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		paddingHorizontal: 6,
		paddingVertical: 4,
		boxShadow: "2px 2px 0 #000",
	},
	searchContainer: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: colors.bg,
		marginHorizontal: 12,
		marginTop: 12,
		marginBottom: 4,
		paddingHorizontal: 8,
		paddingVertical: 6,
		borderRadius: 0,
		borderWidth: 2,
		borderColor: colors.borderStrong,
	},
	searchInput: {
		flex: 1,
		color: colors.text,
		fontSize: 13,
		padding: 0,
		fontFamily: MONO,
	},
	listContent: { paddingVertical: 8, paddingBottom: 40, paddingHorizontal: 8 },
	treeRoot: {
		paddingVertical: 4,
		paddingHorizontal: 6,
	},
	treeBanner: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 6,
		paddingVertical: 4,
		marginBottom: 4,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
		borderStyle: "dashed",
	},
	treeBannerText: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "900",
		letterSpacing: 1.4,
		textTransform: "uppercase",
	},
	treeBannerHint: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		letterSpacing: 0.6,
	},
	folderRow: {
		flexDirection: "row",
		alignItems: "center",
		paddingVertical: 5,
		paddingRight: 6,
	},
	treePrefix: {
		color: colors.border,
		fontFamily: MONO,
		fontSize: 14,
		lineHeight: 22,
	},
	treeTrunk: { color: colors.border, opacity: 0.7 },
	treeBranch: { color: colors.borderStrong, opacity: 0.7 },
	folderToggle: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "700",
		lineHeight: 22,
	},
	folderName: {
		color: colors.text,
		fontSize: 15,
		flex: 1,
		fontFamily: MONO,
		lineHeight: 22,
		marginLeft: 6,
	},
	folderSlash: { color: colors.accent2 },
	folderCount: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "700",
		paddingHorizontal: 6,
		paddingVertical: 2,
		borderWidth: 1,
		borderColor: colors.border,
		marginLeft: 6,
	},
	loaderRow: { flexDirection: "row", alignItems: "center", paddingVertical: 5 },
	emptyRow: {
		flexDirection: "row",
		alignItems: "center",
		paddingVertical: 5,
		paddingRight: 6,
	},
	noteRow: {
		paddingVertical: 5,
		paddingRight: 6,
		borderLeftWidth: 2,
		borderLeftColor: "transparent",
	},
	noteRowSearch: {
		paddingVertical: 8,
		paddingLeft: 12,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
		borderStyle: "dashed",
	},
	noteRowSelected: {
		borderLeftColor: colors.accent,
		backgroundColor: "rgba(247, 201, 72, 0.06)",
	},
	noteRowTop: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
	},
	noteBullet: {
		color: colors.accent2,
		fontSize: 14,
		fontFamily: MONO,
		width: 14,
		lineHeight: 22,
	},
	noteBulletSelected: { color: colors.accent },
	noteTitle: {
		flex: 1,
		color: colors.accent4,
		fontSize: 13,
		fontFamily: MONO,
		lineHeight: 20,
	},
	noteTitleSelected: { color: colors.accent },
	noteDate: { color: colors.muted, fontSize: 11, fontFamily: MONO },
	notePath: {
		color: colors.accent4,
		fontSize: 10,
		fontFamily: MONO,
		marginTop: 3,
		opacity: 0.85,
	},
	headline: {
		color: colors.muted,
		fontSize: 11,
		lineHeight: 16,
		marginTop: 4,
		fontFamily: MONO,
	},
	match: {
		backgroundColor: colors.accent,
		color: colors.bg,
		fontWeight: "700",
		paddingHorizontal: 4,
		paddingVertical: 1,
		borderRadius: 4,
		overflow: "hidden",
	},
	emptyHint: {
		color: colors.muted,
		fontStyle: "italic",
		fontSize: 13,
		fontFamily: MONO,
		lineHeight: 22,
	},
	emptyText: {
		color: colors.muted,
		textAlign: "center",
		marginTop: 40,
		fontSize: 14,
	},
	resultCount: {
		color: colors.muted,
		fontSize: 12,
		marginBottom: 8,
		marginLeft: 12,
	},
	rowDim: { opacity: 0.45 },
	miniDogBox: {
		width: 20,
		alignItems: "center",
		justifyContent: "center",
		marginRight: 6,
	},
	searchLoader: {
		alignItems: "center",
		justifyContent: "center",
		paddingVertical: 16,
		gap: 8,
	},
	searchLoaderText: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		letterSpacing: 0.5,
	},
	scopeRow: {
		flexDirection: "row",
		gap: 6,
		paddingHorizontal: 12,
		paddingTop: 6,
		paddingBottom: 2,
	},
	scopePill: {
		paddingHorizontal: 8,
		paddingVertical: 3,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bg,
	},
	scopePillOn: {
		borderColor: colors.accent2,
		backgroundColor: colors.bgSoft,
	},
	scopePillText: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "600",
	},
	scopePillTextOn: { color: colors.accent2 },
	sectionLabel: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 0.5,
		marginLeft: 12,
		marginTop: 4,
		marginBottom: 4,
		textTransform: "uppercase",
	},
	folderMatchSection: {
		marginBottom: 8,
		paddingBottom: 6,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
		borderStyle: "dashed",
	},
	folderMatchRow: {
		flexDirection: "row",
		alignItems: "center",
		paddingVertical: 6,
		paddingHorizontal: 12,
	},
	folderMatchRowPressed: { backgroundColor: colors.bgSoft },
	folderMatchToggle: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 13,
		fontWeight: "700",
		marginRight: 6,
	},
	folderMatchLeaf: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "600",
	},
	folderMatchPath: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		marginTop: 1,
	},
	folderMatchCount: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "700",
		paddingHorizontal: 6,
		paddingVertical: 2,
		borderWidth: 1,
		borderColor: colors.border,
		marginLeft: 6,
	},
	modalOverlay: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.6)",
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 28,
	},
	modalCard: {
		width: "100%",
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		padding: 18,
	},
	modalTitle: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 16,
		fontWeight: "700",
	},
	modalHint: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		marginTop: 4,
		marginBottom: 12,
	},
	modalInput: {
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bg,
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
		paddingHorizontal: 10,
		paddingVertical: 8,
		marginTop: 12,
	},
	modalActions: {
		flexDirection: "row",
		justifyContent: "flex-end",
		gap: 8,
		marginTop: 16,
	},
	modalBtn: {
		paddingHorizontal: 14,
		paddingVertical: 8,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	modalBtnPrimary: { borderColor: colors.accent2 },
	modalBtnDanger: { borderColor: colors.accent3 },
	moveList: {
		maxHeight: 260,
		marginTop: 12,
		borderWidth: 1,
		borderColor: colors.border,
	},
	moveRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingVertical: 11,
		paddingHorizontal: 12,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	moveRowText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 13,
		flex: 1,
	},
	modalBtnText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "700",
	},
	modalBtnTextPrimary: { color: colors.accent2 },
	modalBtnTextDanger: { color: colors.accent3 },
});
