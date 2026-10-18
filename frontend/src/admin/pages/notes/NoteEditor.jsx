import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PvIconButton, PvInput, PvTag, PvUpload } from "@/ui";
import { useUploadAttachment } from "../../../queries";
import {
	useCreateNote,
	useFolders,
	useNote,
	useUpdateNote,
} from "../../../queries/notesQuery";
import useNoteControlsStore from "../../../store/noteControlsStore";
import useNotesWorkspaceStore from "../../../store/notesWorkspaceStore";
import useUiStore from "../../../store/uiStore";
import { attachmentMarkdown } from "../../../utils/attachments";
import NoteHistoryPopover from "../../components/notes/NoteHistoryPopover";
import SharePopover from "../../components/notes/SharePopover";
import MilkdownEditorComp from "./MilkdownEditorComp";
import { SaveDot } from "./NoteControls";

function useDebounce(fn, delay) {
	const timerRef = useRef(null);
	const fnRef = useRef(fn);
	fnRef.current = fn;

	return useCallback(
		(...args) => {
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => fnRef.current(...args), delay);
		},
		[delay],
	);
}

const SAVE_STATUS = {
	IDLE: "idle",
	SAVING: "saving",
	SAVED: "saved",
	ERROR: "error",
};

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function NoteEditor() {
	const { id: paramId } = useParams();
	const navigate = useNavigate();
	const location = useLocation();
	const isNew = paramId === "new";

	const noteId = isNew || !UUID_RE.test(paramId) ? undefined : paramId;

	useEffect(() => {
		if (paramId && paramId !== "new" && !UUID_RE.test(paramId)) {
			navigate("/", { replace: true });
		}
	}, [paramId, navigate]);

	const { isMobile } = useUiStore();
	// Single mono (dark) theme — the editors only understand "dark" / "light".

	const { data: note, isLoading, isError } = useNote(noteId);
	const { data: folders = [] } = useFolders();
	const createMutation = useCreateNote();
	const updateMutation = useUpdateNote();
	const uploadAttachment = useUploadAttachment();
	// Imperative handle into the Milkdown editor for inserting attachment markdown.
	const editorApiRef = useRef(null);
	// Fields that should grab focus as soon as they appear.
	const searchInputRef = useRef(null);
	const titleInputRef = useRef(null);
	const tagInputRef = useRef(null);
	const openTab = useNotesWorkspaceStore((s) => s.openTab);
	const pinTab = useNotesWorkspaceStore((s) => s.pinTab);
	const publishControls = useNoteControlsStore((s) => s.publish);
	const clearControls = useNoteControlsStore((s) => s.clear);

	// Search-in-page now lives in the shared top-bar popover (NoteControls);
	// this editor just consumes the query and reports match counts.
	const searchOpen = useNoteControlsStore((s) => s.searchOpen);
	const searchQuery = useNoteControlsStore((s) => s.searchQuery);
	const searchAction = useNoteControlsStore((s) => s.searchAction);
	const openSearch = useNoteControlsStore((s) => s.openSearch);
	const closeSearch = useNoteControlsStore((s) => s.closeSearch);
	const setSearchQuery = useNoteControlsStore((s) => s.setSearchQuery);
	const setSearchAction = useNoteControlsStore((s) => s.setSearchAction);
	const setSearchResults = useNoteControlsStore((s) => s.setSearchResults);

	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [tags, setTags] = useState([]);
	const [folder, setFolder] = useState("/");
	const [saveStatus, setSaveStatus] = useState(SAVE_STATUS.IDLE);

	// Register this note as an open tab and keep its label + vault path synced
	// with the live title/folder (openTab refreshes them when the tab already
	// exists). The path feeds the chat context chips. Only real, saved notes
	// get a tab — a "new" draft doesn't until it's saved and the route gains its
	// UUID. Requiring the loaded note to match `noteId` also stops a tab being
	// re-added after delete: removing the note clears `note`, so the effect
	// no-ops instead of re-opening the just-closed tab.
	useEffect(() => {
		if (!noteId || note?.id !== noteId) return;
		const t = title || note.title || "Untitled";
		const f = folder || note.folder || "/";
		const path = !f || f === "/" ? `/${t}` : `${f}/${t}`;
		openTab(noteId, { title: t, path });
	}, [noteId, title, folder, note, openTab]);

	const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
	const [newTagValue, setNewTagValue] = useState("");

	const [isEditingTitle, setIsEditingTitle] = useState(false);

	useEffect(() => {
		if (searchOpen) searchInputRef.current?.focus();
	}, [searchOpen]);
	useEffect(() => {
		if (isEditingTitle) titleInputRef.current?.focus();
	}, [isEditingTitle]);
	useEffect(() => {
		if (tagPopoverOpen) tagInputRef.current?.focus();
	}, [tagPopoverOpen]);

	const searchCount = useNoteControlsStore((s) => s.searchCount);
	const searchIndex = useNoteControlsStore((s) => s.searchIndex);

	// Publish this note's toolbar state up to the layout so the top bar can
	// render the controls. Mobile keeps its own in-editor header instead.
	useEffect(() => {
		if (isMobile) {
			clearControls();
			return;
		}
		publishControls({
			noteId,
			saveStatus,
		});
	}, [isMobile, noteId, saveStatus, publishControls, clearControls]);

	useEffect(() => () => clearControls(), [clearControls]);

	const lastSavedAtRef = useRef(null);
	const pendingSaveRef = useRef(null);
	const isMountedRef = useRef(true);
	const initializedNoteIdRef = useRef(null);
	const savingRef = useRef(false);
	const isDirtyRef = useRef(false);

	// Bumped whenever an EXTERNAL update lands so the Milkdown editor remounts
	// with fresh `initialMarkdown` — it doesn't react to prop changes after mount.
	const [externalVersion, setExternalVersion] = useState(0);

	useEffect(() => {
		if (!note || isNew) return;
		// Don't clobber our own in-flight save or unsaved keystrokes.
		if (savingRef.current || isDirtyRef.current) return;

		const isFreshNote = note.id !== initializedNoteIdRef.current;
		const isExternalUpdate =
			!isFreshNote &&
			lastSavedAtRef.current != null &&
			note.updated_at !== lastSavedAtRef.current;

		if (!isFreshNote && !isExternalUpdate) return;

		setTitle(note.title || "");
		setContent(note.content || "");
		setTags(note.tags || []);
		setFolder(note.folder || "/");
		lastSavedAtRef.current = note.updated_at;
		initializedNoteIdRef.current = note.id;

		if (isExternalUpdate) {
			setExternalVersion((v) => v + 1);
		}
	}, [note, isNew]);

	useEffect(() => {
		if (isNew && initializedNoteIdRef.current !== "new") {
			setTitle("");
			setContent("");
			setTags([]);
			setFolder(location.state?.folder || "/");
			setSaveStatus(SAVE_STATUS.IDLE);
			lastSavedAtRef.current = null;
			initializedNoteIdRef.current = "new";
		}
	}, [isNew, location.state?.folder]);

	useEffect(() => {
		return () => {
			isMountedRef.current = false;
			savingRef.current = false;
			if (pendingSaveRef.current) {
				const {
					id,
					title: t,
					content: c,
					tags: tg,
					folder: f,
				} = pendingSaveRef.current;
				if (id && UUID_RE.test(id)) {
					updateMutation.mutate({
						id,
						title: t,
						content: c,
						tags: tg,
						folder: f,
					});
				} else if (t || c) {
					createMutation.mutate({
						title: t || "Untitled",
						content: c,
						tags: tg,
						folder: f,
					});
				}
			}
		};
	}, [updateMutation.mutate, createMutation.mutate]);

	const doSave = useCallback(
		(noteIdToSave, titleVal, contentVal, tagsVal, folderVal) => {
			if (!isMountedRef.current) return;
			savingRef.current = true;
			setSaveStatus(SAVE_STATUS.SAVING);
			const saveStartTime = Date.now();

			const finishSave = (data) => {
				const elapsed = Date.now() - saveStartTime;
				const remainingTime = Math.max(0, 1000 - elapsed);

				setTimeout(() => {
					if (!isMountedRef.current) return;
					savingRef.current = false;
					isDirtyRef.current = false;
					lastSavedAtRef.current = data.updated_at;
					setSaveStatus(SAVE_STATUS.SAVED);
					setTimeout(() => {
						if (isMountedRef.current) setSaveStatus(SAVE_STATUS.IDLE);
					}, 2000);
				}, remainingTime);
			};

			const failSave = (err) => {
				const elapsed = Date.now() - saveStartTime;
				const remainingTime = Math.max(0, 1000 - elapsed);

				setTimeout(() => {
					if (!isMountedRef.current) return;
					savingRef.current = false;
					setSaveStatus(SAVE_STATUS.ERROR);
					alert(err?.response?.data?.error ?? "Save failed");
				}, remainingTime);
			};

			if (noteIdToSave && UUID_RE.test(noteIdToSave)) {
				updateMutation.mutate(
					{
						id: noteIdToSave,
						title: titleVal,
						content: contentVal,
						tags: tagsVal,
						folder: folderVal,
					},
					{ onSuccess: finishSave, onError: failSave },
				);
			} else {
				createMutation.mutate(
					{
						title: titleVal || "Untitled",
						content: contentVal,
						tags: tagsVal,
						folder: folderVal,
					},
					{
						onSuccess: (data) => {
							initializedNoteIdRef.current = data.id;
							finishSave(data);
							if (data.id && UUID_RE.test(data.id)) {
								navigate(`/notes/${data.id}`, { replace: true });
							}
						},
						onError: failSave,
					},
				);
			}
		},
		[createMutation, updateMutation, navigate],
	);

	const debouncedSave = useDebounce((id, t, c, tg, f) => {
		pendingSaveRef.current = { id, title: t, content: c, tags: tg, folder: f };
		doSave(id, t, c, tg, f);
		pendingSaveRef.current = null;
	}, 1500);

	const triggerSave = useCallback(
		(id, t, c, tg, f) => {
			// Editing a note pins its tab: a transient preview tab becomes permanent
			// the moment the user actually changes something (VSCode behaviour).
			// pinTab no-ops once the tab is already permanent.
			if (id && UUID_RE.test(id)) pinTab(id);
			debouncedSave(id, t, c, tg, f);
		},
		[debouncedSave, pinTab],
	);

	const handleContentChange = useCallback(
		(val) => {
			setContent(val || "");
			isDirtyRef.current = true;
			const currentId = note?.id || noteId;
			triggerSave(currentId, title, val || "", tags, folder);
		},
		[title, tags, folder, triggerSave, note, noteId],
	);

	const handleTitleChange = useCallback(
		(e) => {
			const val = e.target.value;
			setTitle(val);
			isDirtyRef.current = true;
			const currentId = note?.id || noteId;
			triggerSave(currentId, val, content, tags, folder);
		},
		[content, tags, folder, triggerSave, note, noteId],
	);

	const handleRemoveTag = useCallback(
		(removedTag) => {
			const newTags = tags.filter((t) => t !== removedTag);
			setTags(newTags);
			isDirtyRef.current = true;
			const currentId = note?.id || noteId;
			triggerSave(currentId, title, content, newTags, folder);
		},
		[title, content, folder, tags, triggerSave, note, noteId],
	);

	const handleFolderChange = useCallback(
		(e) => {
			const val = e.target.value;
			setFolder(val);
			isDirtyRef.current = true;
			const currentId = note?.id || noteId;
			triggerSave(currentId, title, content, tags, val);
		},
		[title, content, tags, triggerSave, note, noteId],
	);

	const handleAddTagConfirm = useCallback(
		(e) => {
			if (e.key === "Enter" || e.type === "blur") {
				const val = newTagValue.toLowerCase().replace(/\s/g, "").slice(0, 50);
				if (val && !tags.includes(val)) {
					const newTags = [...tags, val];
					setTags(newTags);
					isDirtyRef.current = true;
					const currentId = note?.id || noteId;
					triggerSave(currentId, title, content, newTags, folder);
				}
				setTagPopoverOpen(false);
				setNewTagValue("");
			}
		},
		[newTagValue, tags, title, content, folder, triggerSave, note, noteId],
	);

	const handleAttachFile = useCallback(
		async ([file]) => {
			if (!file) return;
			try {
				const currentId = note?.id || noteId;
				const { publicUrl, filename } = await uploadAttachment.mutateAsync({
					file,
					noteId: currentId,
				});
				if (!publicUrl) throw new Error("No public URL returned");
				editorApiRef.current?.insertMarkdown(
					attachmentMarkdown(filename, publicUrl),
				);
			} catch (err) {
				alert(err?.response?.data?.error ?? err.message ?? "Attachment failed");
			}
		},
		[uploadAttachment, note, noteId],
	);

	if (isLoading && !isNew) {
		return <div className="notes-pixel-empty">Loading...</div>;
	}
	if (isError && !isNew) {
		return <div className="notes-pixel-empty">Failed to load note.</div>;
	}

	return (
		<div className="note-editor">
			{isMobile && (
				<div className="editor-header note-mobile-header">
					<div className="note-mobile-main">
						<PvIconButton
							icon="◀"
							label="Back to notes"
							onClick={() => navigate("/notes")}
						/>

						{searchOpen ? (
							<div className="note-mobile-search">
								<div className="note-mobile-search-field">
									<PvInput
										ref={searchInputRef}
										size="sm"
										className={`note-mobile-search-input${searchQuery ? " has-count" : ""}`}
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
										<span className="note-mobile-search-count">
											{searchCount > 0
												? `${searchIndex + 1}/${searchCount}`
												: "0/0"}
										</span>
									)}
									<PvIconButton
										size="sm"
										variant="ghost"
										className="note-mobile-search-clear"
										icon="×"
										label={searchQuery ? "Clear search" : "Close search"}
										onClick={() => {
											if (searchQuery) setSearchQuery("");
											else closeSearch();
										}}
									/>
								</div>
								{searchQuery && (
									<>
										<PvIconButton
											size="sm"
											icon="▲"
											label="Previous (Shift+Enter)"
											onClick={() =>
												setSearchAction({ dir: "prev", ts: Date.now() })
											}
										/>
										<PvIconButton
											size="sm"
											icon="▼"
											label="Next (Enter)"
											onClick={() =>
												setSearchAction({ dir: "next", ts: Date.now() })
											}
										/>
									</>
								)}
							</div>
						) : isEditingTitle ? (
							<PvInput
								ref={titleInputRef}
								size="sm"
								className="note-mobile-title-input"
								value={title}
								onChange={handleTitleChange}
								onBlur={() => setIsEditingTitle(false)}
								onKeyDown={(e) => e.key === "Enter" && setIsEditingTitle(false)}
								placeholder="Untitled"
							/>
						) : (
							<button
								type="button"
								className="note-mobile-title"
								onClick={() => {
									openSearch();
								}}
								onDoubleClick={(e) => {
									e.stopPropagation();
									closeSearch();
									setIsEditingTitle(true);
								}}
								title="Click to search in page, Double-click to rename"
							>
								{title || "Untitled"}
							</button>
						)}
					</div>
					<div className="note-mobile-actions">
						<SaveDot status={saveStatus} />
						{noteId && <NoteHistoryPopover noteId={noteId} />}
						{noteId && <SharePopover noteId={noteId} isMobile={isMobile} />}
						<PvIconButton
							variant="danger"
							icon="×"
							label="Close note"
							onClick={() => navigate("/notes")}
						/>
					</div>
				</div>
			)}

			<div className="note-editor-body">
				{initializedNoteIdRef.current ? (
					<MilkdownEditorComp
						key={`${initializedNoteIdRef.current}-${externalVersion}`}
						initialMarkdown={content}
						onChange={handleContentChange}
						isMobile={isMobile}
						searchQuery={searchOpen ? searchQuery : ""}
						searchAction={searchAction}
						onSearchUpdate={({ count, activeIndex }) =>
							setSearchResults(count, activeIndex)
						}
						editorApiRef={editorApiRef}
					/>
				) : (
					<div className="notes-pixel-empty">Loading...</div>
				)}
			</div>

			<div className="editor-footer">
				<PvUpload
					onFiles={handleAttachFile}
					disabled={uploadAttachment.isPending}
				>
					<PvIconButton
						size="sm"
						icon={uploadAttachment.isPending ? "⏳" : "📎"}
						label="Attach a file"
						disabled={uploadAttachment.isPending}
					/>
				</PvUpload>
				{tags.map((t) => (
					<PvTag
						key={t}
						onRemove={() => handleRemoveTag(t)}
						removeLabel={`Remove tag ${t}`}
					>
						{t}
					</PvTag>
				))}

				{tagPopoverOpen ? (
					<PvInput
						ref={tagInputRef}
						size="sm"
						className="note-tag-input"
						value={newTagValue}
						onChange={(e) => setNewTagValue(e.target.value)}
						onKeyDown={handleAddTagConfirm}
						onBlur={handleAddTagConfirm}
						placeholder="Add tag..."
					/>
				) : (
					<PvIconButton
						size="sm"
						variant="ghost"
						icon="+"
						label="Add tag"
						onClick={() => setTagPopoverOpen(true)}
					/>
				)}
			</div>
		</div>
	);
}
