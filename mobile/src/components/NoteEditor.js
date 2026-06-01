import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	Alert,
	KeyboardAvoidingView,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createNote, deleteNote, fetchNote, updateNote } from "../api/notesApi";
import { uploadAttachment } from "../api/storageApi";
import { notesKeys } from "../queries/notesQuery";
import { attachmentMarkdown } from "../utils/attachments";
import { colors } from "../utils/theme";

// Loaded lazily so the editor still runs in a build without the native module.
let DocumentPicker = null;
try {
	DocumentPicker = require("expo-document-picker");
} catch {
	DocumentPicker = null;
}
import MarkdownView from "./MarkdownView";
import PiumaLoader from "./PiumaLoader";
import ShareSheet from "./ShareSheet";
import { BottomBar, useTopInset } from "./SystemBars";

const AUTOSAVE_MS = 1500;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 50;

const MONO = Platform.select({
	ios: "Menlo",
	android: "monospace",
	default: "monospace",
});

const cleanTag = (raw) =>
	raw.toLowerCase().replace(/\s+/g, "").slice(0, MAX_TAG_LEN);

const STATUS = {
	idle: { icon: "✓", color: colors.accent2, label: "Saved" },
	saving: { icon: "⏳", color: colors.accent, label: "Saving" },
	saved: { icon: "✓", color: colors.accent2, label: "Saved" },
	error: { icon: "×", color: colors.accent3, label: "Failed" },
	unsaved: { icon: "•", color: colors.muted, label: "Unsaved" },
};

export default function NoteEditor({
	noteId,
	folder = "/",
	onOpenDrawer,
	onDeleted,
	onCreated,
	onExit,
}) {
	const queryClient = useQueryClient();
	const insets = useSafeAreaInsets();
	const topInset = useTopInset();
	const isEditing = !!noteId;

	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [tags, setTags] = useState([]);
	const [newTag, setNewTag] = useState("");
	const [showTagInput, setShowTagInput] = useState(false);
	const [status, setStatus] = useState("idle");
	const [currentId, setCurrentId] = useState(noteId || null);
	const [mode, setMode] = useState(isEditing ? "preview" : "edit");

	const [isSearchMode, setIsSearchMode] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchCount, setSearchCount] = useState(0);
	const [activeMatch, setActiveMatch] = useState(0);

	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [showShare, setShowShare] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [attaching, setAttaching] = useState(false);

	// Tracks the content TextInput caret so attachments insert where the user
	// is typing rather than always appending.
	const selectionRef = useRef({ start: 0, end: 0 });

	const hydratedRef = useRef(false);
	const dirtyRef = useRef(false);
	const debounceRef = useRef(null);
	const previewScrollRef = useRef(null);
	// Timestamp of the last successful save WE performed. Used to distinguish
	// our own writes (echo back via React Query cache) from external changes
	// pushed via the SSE live-update channel.
	const lastSavedAtRef = useRef(null);

	const { data: note, isLoading } = useQuery({
		queryKey: notesKeys.detail(noteId),
		queryFn: () => fetchNote(noteId),
		enabled: isEditing,
	});

	useEffect(() => {
		if (!note) return;
		// Never overwrite unsaved edits — user's typing wins until they save.
		if (dirtyRef.current) return;

		const isFreshHydrate = !hydratedRef.current;
		const isExternalUpdate =
			hydratedRef.current &&
			lastSavedAtRef.current != null &&
			note.updated_at !== lastSavedAtRef.current;

		if (!isFreshHydrate && !isExternalUpdate) return;

		setTitle(note.title || "");
		setContent(note.content || "");
		setTags(note.tags || []);
		lastSavedAtRef.current = note.updated_at;
		hydratedRef.current = true;
		setStatus("saved");
	}, [note]);

	const saveMutation = useMutation({
		mutationFn: async (payload) => {
			if (currentId) return updateNote({ id: currentId, ...payload });
			return createNote({ folder, ...payload });
		},
		onSuccess: (data) => {
			dirtyRef.current = false;
			lastSavedAtRef.current = data?.updated_at ?? lastSavedAtRef.current;
			setStatus("saved");
			if (!currentId && data?.id) {
				setCurrentId(data.id);
				onCreated?.(data.id);
			}
			queryClient.setQueryData(notesKeys.detail(data.id), data);
			queryClient.invalidateQueries({ queryKey: ["notes", "list"] });
			queryClient.invalidateQueries({ queryKey: ["notes", "browse"] });
		},
		onError: (err) => {
			console.error(
				"[editor] save failed",
				err.response?.status,
				err.response?.data,
			);
			setStatus("error");
		},
	});

	const saveRef = useRef(saveMutation.mutate);
	saveRef.current = saveMutation.mutate;

	useEffect(() => {
		if (!dirtyRef.current) return;
		if (isEditing && !hydratedRef.current) return;
		setStatus("unsaved");
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			setStatus("saving");
			saveRef.current({
				title: title.trim() || "Untitled",
				content,
				tags,
			});
		}, AUTOSAVE_MS);
		return () => debounceRef.current && clearTimeout(debounceRef.current);
	}, [title, content, tags, isEditing]);

	const markDirty = () => {
		dirtyRef.current = true;
	};

	// Splice a markdown snippet in at the caret (on its own block), then mark
	// dirty so autosave picks it up.
	const insertSnippet = (snippet) => {
		setContent((prev) => {
			const { start, end } = selectionRef.current;
			const at = Math.min(Math.max(start, 0), prev.length);
			const to = Math.min(Math.max(end, at), prev.length);
			const before = prev.slice(0, at);
			const after = prev.slice(to);
			const lead = before && !before.endsWith("\n") ? "\n\n" : "";
			const trail = after && !after.startsWith("\n") ? "\n" : "";
			return `${before}${lead}${snippet}${trail}${after}`;
		});
		markDirty();
	};

	const handleAttach = async () => {
		if (attaching) return;
		if (!DocumentPicker) {
			Alert.alert(
				"Rebuild required",
				"Attachments need the expo-document-picker native module. Rebuild the app to enable it.",
			);
			return;
		}
		try {
			const res = await DocumentPicker.getDocumentAsync({
				copyToCacheDirectory: true,
				multiple: false,
			});
			if (res.canceled) return;
			const asset = res.assets?.[0];
			if (!asset) return;
			setAttaching(true);
			const { publicUrl, filename } = await uploadAttachment({
				file: { uri: asset.uri, name: asset.name, mimeType: asset.mimeType },
				noteId: currentId,
			});
			if (!publicUrl) throw new Error("No public URL returned");
			insertSnippet(attachmentMarkdown(filename, publicUrl));
		} catch (e) {
			Alert.alert(
				"Attachment failed",
				e?.response?.data?.message || e.message || "Could not upload the file.",
			);
		} finally {
			setAttaching(false);
		}
	};

	const deleteM = useMutation({
		mutationFn: () => deleteNote(currentId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: notesKeys.all });
			onDeleted?.();
		},
		onError: () => Alert.alert("Delete failed", "Could not delete the note."),
	});

	const handleDelete = () => setConfirmDelete(true);

	const confirmDeleteNote = () => {
		setConfirmDelete(false);
		deleteM.mutate();
	};

	// Flush any pending autosave before leaving so unsaved edits don't get
	// dropped when the editor unmounts.
	const handleExit = useCallback(() => {
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
			debounceRef.current = null;
			if (dirtyRef.current) {
				saveRef.current({
					title: title.trim() || "Untitled",
					content,
					tags,
				});
			}
		}
		onExit?.();
	}, [title, content, tags, onExit]);

	const addTag = () => {
		const t = cleanTag(newTag);
		if (!t || tags.includes(t) || tags.length >= MAX_TAGS) {
			setNewTag("");
			setShowTagInput(false);
			return;
		}
		markDirty();
		setTags([...tags, t]);
		setNewTag("");
		setShowTagInput(false);
	};

	const removeTag = (t) => {
		markDirty();
		setTags(tags.filter((x) => x !== t));
	};

	const enterSearch = () => {
		if (isEditingTitle) return;
		setIsSearchMode(true);
		setActiveMatch(0);
		if (mode !== "preview") setMode("preview");
	};

	const exitSearch = () => {
		setIsSearchMode(false);
		setSearchQuery("");
		setActiveMatch(0);
		setSearchCount(0);
	};

	const onSearchChange = (v) => {
		setSearchQuery(v);
		setActiveMatch(0);
	};

	const nextMatch = () => {
		if (searchCount === 0) return;
		setActiveMatch((i) => (i + 1) % searchCount);
	};

	const prevMatch = () => {
		if (searchCount === 0) return;
		setActiveMatch((i) => (i - 1 + searchCount) % searchCount);
	};

	const handleMatchCount = useCallback((count) => {
		setSearchCount(count);
		setActiveMatch((i) => (count > 0 ? Math.min(i, count - 1) : 0));
	}, []);

	if (isEditing && isLoading) {
		return <PiumaLoader message="Loading note" />;
	}

	const s = STATUS[status];
	const effectiveMode = isSearchMode ? "preview" : mode;

	return (
		<KeyboardAvoidingView
			style={[styles.container, { paddingTop: topInset }]}
			behavior={Platform.OS === "ios" ? "padding" : undefined}
		>
			<View style={styles.header}>
				<TouchableOpacity onPress={onOpenDrawer} style={styles.iconButton}>
					<Ionicons name="menu" size={18} color={colors.text} />
				</TouchableOpacity>

				<View style={styles.headerMiddle}>
					{isSearchMode ? (
						<View style={styles.searchRow}>
							<Ionicons name="search" size={14} color={colors.muted} />
							<TextInput
								autoFocus
								style={styles.searchInput}
								placeholder="Search in page..."
								placeholderTextColor={colors.muted}
								value={searchQuery}
								onChangeText={onSearchChange}
								onSubmitEditing={nextMatch}
								autoCapitalize="none"
								autoCorrect={false}
								returnKeyType="search"
							/>
							{searchQuery.length > 0 && (
								<Text style={styles.searchCount}>
									{searchCount === 0
										? "0/0"
										: `${activeMatch + 1}/${searchCount}`}
								</Text>
							)}
							<TouchableOpacity
								onPress={prevMatch}
								disabled={searchCount === 0}
								style={styles.searchBtn}
							>
								<Ionicons
									name="chevron-up"
									size={14}
									color={searchCount === 0 ? colors.muted : colors.text}
								/>
							</TouchableOpacity>
							<TouchableOpacity
								onPress={nextMatch}
								disabled={searchCount === 0}
								style={styles.searchBtn}
							>
								<Ionicons
									name="chevron-down"
									size={14}
									color={searchCount === 0 ? colors.muted : colors.text}
								/>
							</TouchableOpacity>
							<TouchableOpacity
								onPress={() =>
									searchQuery ? onSearchChange("") : exitSearch()
								}
								style={styles.searchBtn}
							>
								<Ionicons name="close" size={14} color={colors.text} />
							</TouchableOpacity>
						</View>
					) : isEditingTitle ? (
						<TextInput
							autoFocus
							style={styles.titleInput}
							placeholder="Untitled"
							placeholderTextColor={colors.muted}
							value={title}
							onChangeText={(v) => {
								markDirty();
								setTitle(v);
							}}
							onBlur={() => setIsEditingTitle(false)}
							onSubmitEditing={() => setIsEditingTitle(false)}
							maxLength={500}
							returnKeyType="done"
						/>
					) : (
						<Pressable
							onPress={enterSearch}
							onLongPress={() => setIsEditingTitle(true)}
							delayLongPress={300}
							style={styles.titleWrap}
						>
							<Text
								style={[styles.titleText, !title && { color: colors.muted }]}
								numberOfLines={1}
							>
								{title || "Untitled"}
							</Text>
						</Pressable>
					)}
				</View>

				{!isSearchMode && (
					<View style={styles.headerRight}>
						<View
							style={styles.saveBtn}
							accessibilityLabel={`Save status: ${s.label}`}
						>
							<Text style={[styles.saveIcon, { color: s.color }]}>
								{s.icon}
							</Text>
						</View>
						<TouchableOpacity
							onPress={() => setMode(mode === "edit" ? "preview" : "edit")}
							style={styles.iconButton}
						>
							<Ionicons
								name={mode === "edit" ? "eye-outline" : "create-outline"}
								size={16}
								color={colors.accent}
							/>
						</TouchableOpacity>
						<TouchableOpacity
							onPress={handleAttach}
							disabled={attaching}
							style={styles.iconButton}
							accessibilityLabel="Attach file"
							hitSlop={6}
						>
							<Ionicons
								name={attaching ? "hourglass-outline" : "attach-outline"}
								size={16}
								color={attaching ? colors.muted : colors.accent4}
							/>
						</TouchableOpacity>
						{currentId ? (
							<TouchableOpacity
								onPress={() => setShowShare(true)}
								style={styles.iconButton}
								accessibilityLabel="Share note"
								hitSlop={6}
							>
								<Ionicons
									name="share-social-outline"
									size={16}
									color={colors.accent2}
								/>
							</TouchableOpacity>
						) : null}
						{onExit ? (
							<TouchableOpacity
								onPress={handleExit}
								style={styles.iconButton}
								accessibilityLabel="Close note"
								hitSlop={6}
							>
								<Ionicons name="close" size={18} color={colors.text} />
							</TouchableOpacity>
						) : null}
					</View>
				)}
			</View>

			{effectiveMode === "edit" ? (
				<View style={styles.editArea}>
					<TextInput
						style={styles.contentInput}
						placeholder="Start writing in markdown..."
						placeholderTextColor={colors.muted}
						value={content}
						onChangeText={(v) => {
							markDirty();
							setContent(v);
						}}
						onSelectionChange={(e) => {
							selectionRef.current = e.nativeEvent.selection;
						}}
						multiline
						textAlignVertical="top"
					/>
					{currentId ? (
						<TouchableOpacity
							onPress={handleDelete}
							style={styles.deleteFloating}
						>
							<Ionicons name="trash-outline" size={14} color={colors.accent3} />
						</TouchableOpacity>
					) : null}
				</View>
			) : (
				<ScrollView
					ref={previewScrollRef}
					style={styles.previewScroll}
					contentContainerStyle={styles.previewContent}
					keyboardShouldPersistTaps="handled"
				>
					{content.trim() ? (
						<MarkdownView
							source={content}
							searchQuery={isSearchMode ? searchQuery : ""}
							activeMatchIndex={activeMatch}
							scrollRef={previewScrollRef}
							onMatchCountChange={handleMatchCount}
						/>
					) : (
						<Text style={styles.emptyPreview}>
							This note is empty. Tap the pencil to start writing.
						</Text>
					)}
				</ScrollView>
			)}

			<View style={[styles.footer, { paddingBottom: insets.bottom }]}>
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={styles.tagsBar}
				>
					{tags.map((t) => (
						<Pressable
							key={t}
							onPress={() => removeTag(t)}
							style={styles.tagChip}
						>
							<Text style={styles.tagText}>#{t}</Text>
							<Text style={styles.tagX}>×</Text>
						</Pressable>
					))}
					{showTagInput ? (
						<TextInput
							autoFocus
							style={styles.tagInput}
							value={newTag}
							onChangeText={(v) => setNewTag(cleanTag(v))}
							onBlur={addTag}
							onSubmitEditing={addTag}
							placeholder="tag"
							placeholderTextColor={colors.muted}
							maxLength={MAX_TAG_LEN}
						/>
					) : tags.length < MAX_TAGS ? (
						<TouchableOpacity
							onPress={() => setShowTagInput(true)}
							style={styles.addTagBtn}
						>
							<Text style={styles.addTagText}>+ tag</Text>
						</TouchableOpacity>
					) : null}
				</ScrollView>
			</View>

			<ShareSheet
				visible={showShare}
				onClose={() => setShowShare(false)}
				noteId={currentId}
				noteTitle={title}
			/>

			<Modal
				visible={confirmDelete}
				transparent
				animationType="fade"
				onRequestClose={() => setConfirmDelete(false)}
			>
				<Pressable
					style={styles.modalOverlay}
					onPress={() => setConfirmDelete(false)}
				>
					<Pressable style={styles.modalCard} onPress={() => {}}>
						<Text style={styles.modalTitle}>Delete note</Text>
						<Text style={styles.modalHint} numberOfLines={3}>
							Permanently delete "{title.trim() || "Untitled"}"? This action
							cannot be undone.
						</Text>
						<View style={styles.modalActions}>
							<TouchableOpacity
								style={styles.modalBtn}
								onPress={() => setConfirmDelete(false)}
							>
								<Text style={styles.modalBtnText}>Cancel</Text>
							</TouchableOpacity>
							<TouchableOpacity
								style={[styles.modalBtn, styles.modalBtnDanger]}
								onPress={confirmDeleteNote}
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
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: colors.bg },
	header: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 8,
		paddingVertical: 6,
		gap: 6,
		borderBottomWidth: 2,
		borderBottomColor: colors.borderStrong,
		borderStyle: "dashed",
		backgroundColor: colors.panel,
	},
	headerMiddle: { flex: 1, minWidth: 0 },
	headerRight: { flexDirection: "row", alignItems: "center", gap: 6 },
	iconButton: {
		width: 32,
		height: 32,
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		boxShadow: "2px 2px 0 #000",
		alignItems: "center",
		justifyContent: "center",
	},
	saveBtn: {
		width: 32,
		height: 32,
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		boxShadow: "2px 2px 0 #000",
		alignItems: "center",
		justifyContent: "center",
	},
	saveIcon: {
		fontSize: 16,
		fontWeight: "700",
		fontFamily: MONO,
		lineHeight: 18,
	},
	titleWrap: {
		height: 32,
		justifyContent: "center",
		paddingHorizontal: 8,
		borderWidth: 2,
		borderColor: "transparent",
	},
	titleText: {
		fontSize: 14,
		fontWeight: "700",
		color: colors.accent,
		fontFamily: MONO,
	},
	titleInput: {
		height: 32,
		fontSize: 14,
		fontWeight: "700",
		color: colors.accent,
		fontFamily: MONO,
		paddingHorizontal: 8,
		paddingVertical: 0,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bg,
	},
	searchRow: {
		flexDirection: "row",
		alignItems: "center",
		height: 32,
		backgroundColor: colors.bg,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		paddingHorizontal: 6,
		gap: 2,
	},
	searchInput: {
		flex: 1,
		minWidth: 0,
		color: colors.accent4,
		fontSize: 13,
		padding: 0,
		fontFamily: MONO,
	},
	searchCount: {
		color: colors.muted,
		fontSize: 9,
		fontFamily: MONO,
		marginHorizontal: 2,
		minWidth: 24,
		textAlign: "right",
	},
	searchBtn: {
		paddingHorizontal: 2,
		paddingVertical: 2,
	},
	editArea: { flex: 1, position: "relative" },
	contentInput: {
		flex: 1,
		fontSize: 14,
		color: colors.text,
		paddingHorizontal: 16,
		paddingTop: 12,
		paddingBottom: 60,
		lineHeight: 22,
		fontFamily: MONO,
		backgroundColor: colors.bg,
	},
	deleteFloating: {
		position: "absolute",
		top: 8,
		right: 8,
		width: 28,
		height: 28,
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		boxShadow: "2px 2px 0 #000",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 10,
	},
	previewScroll: { flex: 1, backgroundColor: colors.bg },
	previewContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 72 },
	emptyPreview: {
		color: colors.muted,
		fontStyle: "italic",
		textAlign: "center",
		marginTop: 40,
		fontFamily: MONO,
	},
	footer: {
		position: "absolute",
		left: 0,
		right: 0,
		bottom: 0,
		backgroundColor: "transparent",
	},
	tagsBar: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 12,
		paddingVertical: 8,
		gap: 6,
	},
	tagsLabel: {
		fontSize: 11,
		color: colors.muted,
		fontFamily: MONO,
		marginRight: 4,
	},
	tagChip: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: colors.bgSoft,
		borderWidth: 1,
		borderColor: colors.borderStrong,
		paddingHorizontal: 8,
		paddingVertical: 2,
		gap: 4,
	},
	tagText: { color: colors.text, fontSize: 11, fontFamily: MONO },
	tagX: {
		color: colors.accent3,
		fontSize: 14,
		lineHeight: 14,
		fontWeight: "700",
	},
	addTagBtn: {
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		paddingHorizontal: 10,
		paddingVertical: 2,
		boxShadow: "2px 2px 0 #000",
	},
	addTagText: {
		color: colors.text,
		fontSize: 12,
		fontFamily: MONO,
		fontWeight: "700",
	},
	tagInput: {
		backgroundColor: colors.bg,
		borderWidth: 2,
		borderColor: colors.accent,
		paddingHorizontal: 8,
		paddingVertical: 2,
		color: colors.text,
		fontSize: 12,
		fontFamily: MONO,
		minWidth: 80,
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
	modalBtnDanger: { borderColor: colors.accent3 },
	modalBtnText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "700",
	},
	modalBtnTextDanger: { color: colors.accent3 },
});
