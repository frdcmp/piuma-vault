import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import EventSource from "react-native-sse";
import { refreshAccessToken } from "../api/axiosInstance";
import {
	browseFolder,
	createNote,
	deleteNote,
	fetchFolders,
	fetchNote,
	fetchNotes,
	fetchTags,
	updateNote,
} from "../api/notesApi";
import { useAuthStore } from "../stores/authStore";
import { isLocalEcho, markLocalChange } from "./liveUpdates";

// SSE channel note mutations broadcast on. Marked at request start so the echo
// of a local change is suppressed (see liveUpdates `markLocalChange`).
const NOTES_SSE_PATH = "/admin/notes/events";

export const notesKeys = {
	all: ["notes"],
	list: (params) => ["notes", "list", params],
	detail: (id) => ["notes", "detail", id],
	tags: () => ["notes", "tags"],
	folders: () => ["notes", "folders"],
	browse: (path) => ["notes", "browse", path],
};

// ── Surgical cache reconciliation (note updates) ──────────────────────────────
//
// An update (the frequent auto-save) only changes a note's summary fields, so
// patch it into the loaded list rows in place instead of refetching. The list
// is `{ data: NoteListItem[], total, … }` ordered by updated_at DESC. Search
// caches can't be re-ranked client-side, so they fall back to a refetch. The
// folder-tree sidebar (browse/folders) only changes when the title or folder
// changes — refresh it only then.
const byUpdatedDesc = (a, b) =>
	new Date(b.updated_at ?? 0) - new Date(a.updated_at ?? 0);

export const reconcileNoteUpdate = (qc, note) => {
	if (!note?.id) return;
	const prev = qc.getQueryData(notesKeys.detail(note.id));
	qc.setQueryData(notesKeys.detail(note.id), note);

	for (const q of qc.getQueryCache().findAll({ queryKey: ["notes", "list"] })) {
		const params = q.queryKey[2] ?? {};
		if (params.search) {
			// Relevance ranking can't be re-derived locally — let it refetch.
			qc.invalidateQueries({ queryKey: q.queryKey });
			continue;
		}
		qc.setQueryData(q.queryKey, (old) => {
			if (!old?.data) return old;
			const i = old.data.findIndex((n) => n.id === note.id);
			if (i === -1) return old; // not in this list — leave it untouched
			const data = [...old.data];
			data[i] = {
				...data[i],
				title: note.title,
				tags: note.tags,
				folder: note.folder,
				updated_at: note.updated_at,
			};
			data.sort(byUpdatedDesc);
			return { ...old, data };
		});
	}

	// Title or folder change alters the file-tree sidebar; refresh it only then.
	if (!prev || prev.title !== note.title || prev.folder !== note.folder) {
		qc.invalidateQueries({ queryKey: ["notes", "browse"] });
		qc.invalidateQueries({ queryKey: notesKeys.folders() });
	}
};

// ── List ──────────────────────────────────────────────────────────────────

export const useNotes = (params = {}, options = {}) =>
	useQuery({
		queryKey: notesKeys.list(params),
		queryFn: () => fetchNotes(params),
		keepPreviousData: true,
		staleTime: 30_000,
		...options,
	});

// ── Single Note ───────────────────────────────────────────────────────────

// UUID regex — reject undefined, null, "undefined", empty strings, etc.
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const useNote = (id) =>
	useQuery({
		queryKey: notesKeys.detail(id),
		queryFn: () => fetchNote(id),
		enabled: UUID_RE.test(id),
	});

// ── Create ────────────────────────────────────────────────────────────────

export const useCreateNote = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createNote,
		onMutate: () => markLocalChange(NOTES_SSE_PATH),
		onSuccess: (data) => {
			// Pre-populate the cache for this newly created note; a new note is a
			// structural change (new list/tree entry), so refresh the family.
			qc.setQueryData(notesKeys.detail(data.id), data);
			qc.invalidateQueries({ queryKey: notesKeys.all });
		},
	});
};

// ── Update (auto-save) ────────────────────────────────────────────────────

export const useUpdateNote = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateNote,
		onMutate: () => markLocalChange(NOTES_SSE_PATH),
		// Patch the list/detail caches in place (see reconcileNoteUpdate) instead
		// of refetching the list on every auto-save.
		onSuccess: (data) => reconcileNoteUpdate(qc, data),
	});
};

// ── Delete ────────────────────────────────────────────────────────────────

export const useDeleteNote = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteNote,
		onMutate: () => markLocalChange(NOTES_SSE_PATH),
		onSuccess: (_data, id) => {
			// Remove the deleted note from cache so no stale fetches
			qc.removeQueries({ queryKey: notesKeys.detail(id) });
			qc.invalidateQueries({ queryKey: notesKeys.all });
		},
	});
};

// ── Tags ──────────────────────────────────────────────────────────────────

export const useTags = () =>
	useQuery({
		queryKey: notesKeys.tags(),
		queryFn: fetchTags,
		staleTime: 60_000,
	});

// ── Folders ───────────────────────────────────────────────────────────────

export const useFolders = () =>
	useQuery({
		queryKey: notesKeys.folders(),
		queryFn: fetchFolders,
		staleTime: 60_000,
	});

// ── Browse (lazy-load directory) ──────────────────────────────────────────

export const useBrowseFolder = (path) =>
	useQuery({
		queryKey: notesKeys.browse(path),
		queryFn: () => browseFolder(path),
		enabled: !!path,
		staleTime: 30_000,
	});

// ── Live updates (SSE) ────────────────────────────────────────────────────
//
// Subscribes to the backend notes event stream so this device sees changes
// made elsewhere (web, another phone, an integration via API key, an LLM
// hitting a share link). On any mutation: invalidates the notes list and —
// when the changed note matches `activeNoteId` — the detail query as well.
//
// Differences from the web build:
//  - Uses `react-native-sse` (RN has no built-in EventSource).
//  - Sends the JWT in `Authorization: Bearer` instead of in the URL; the
//    backend accepts either, but headers keep tokens out of access logs.
//  - Token comes from the zustand auth store, not localStorage.
//  - Reuses the existing axios `refreshAccessToken()` so refresh flows stay
//    single-flight across the whole app.
//
// On a permanent close (typically 401), the hook refreshes the access token
// once, then reopens the stream with exponential backoff. On every successful
// (re)open after a failure, it invalidates the queries so events that fired
// during the gap aren't lost.
const BASE_URL =
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1";

export const useNotesLiveUpdates = (activeNoteId) => {
	const qc = useQueryClient();

	useEffect(() => {
		let es = null;
		let reconnectTimer = null;
		let attempts = 0;
		let cancelled = false;

		const refreshStructural = () => {
			qc.invalidateQueries({ queryKey: ["notes", "list"] });
			// The folder tree is driven by browse(path) queries — invalidate the
			// whole browse family so create/rename/move/delete refresh it.
			qc.invalidateQueries({ queryKey: ["notes", "browse"] });
		};

		const handleNoteEvent = async (evt) => {
			let payload;
			try {
				payload = JSON.parse(evt.data);
			} catch {
				return;
			}
			// Drop the echo of a change this device just made — its mutation already
			// patched the cache. (Backfill on reconnect/foreground bypasses this.)
			if (isLocalEcho(NOTES_SSE_PATH)) return;

			if (!payload?.id) {
				refreshStructural();
				return;
			}
			if (payload.action === "deleted") {
				qc.removeQueries({ queryKey: notesKeys.detail(payload.id) });
				refreshStructural();
				return;
			}
			if (payload.action === "created") {
				refreshStructural();
				return;
			}
			// updated → patch in place from the fetched row (also refreshes the
			// open editor if this is the active note); fall back to structural.
			try {
				const note = await fetchNote(payload.id);
				if (note?.id) {
					reconcileNoteUpdate(qc, note);
					return;
				}
			} catch {
				/* fall through */
			}
			refreshStructural();
		};

		const close = () => {
			if (!es) return;
			try {
				es.removeAllEventListeners();
			} catch {
				/* ignore */
			}
			try {
				es.close();
			} catch {
				/* ignore */
			}
			es = null;
		};

		const connect = () => {
			if (cancelled) return;

			const token = useAuthStore.getState().token;
			if (!token) return; // logged out

			es = new EventSource(`${BASE_URL}/admin/notes/events`, {
				headers: { Authorization: `Bearer ${token}` },
				// react-native-sse has its own retry — disable it so our manual
				// loop is the single source of reconnect logic.
				pollingInterval: 0,
			});

			es.addEventListener("note", handleNoteEvent);

			es.addEventListener("open", () => {
				if (attempts > 0) {
					qc.invalidateQueries({ queryKey: ["notes", "list"] });
					qc.invalidateQueries({ queryKey: ["notes", "browse"] });
					if (activeNoteId) {
						qc.invalidateQueries({
							queryKey: notesKeys.detail(activeNoteId),
						});
					}
				}
				attempts = 0;
			});

			const onFailure = async () => {
				if (cancelled) return;
				close();
				attempts += 1;

				// First failure on an established session → token most likely
				// expired. Refresh once before reconnecting.
				if (attempts === 1) {
					try {
						await refreshAccessToken();
					} catch {
						/* fall through — backoff will retry */
					}
					if (cancelled) return;
				}

				const delay = Math.min(30_000, 1000 * 2 ** (attempts - 1));
				reconnectTimer = setTimeout(connect, delay);
			};

			es.addEventListener("error", onFailure);
			es.addEventListener("close", onFailure);
		};

		connect();

		// Backgrounding silently kills the SSE socket (often with no error/close
		// event), so the stream is dead on return. On foreground, tear down any
		// zombie connection, backfill changes made while away, and reconnect.
		const appStateSub = AppState.addEventListener("change", (status) => {
			if (cancelled || status !== "active") return;
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			close();
			attempts = 0;
			qc.invalidateQueries({ queryKey: ["notes", "list"] });
			qc.invalidateQueries({ queryKey: ["notes", "browse"] });
			if (activeNoteId) {
				qc.invalidateQueries({ queryKey: notesKeys.detail(activeNoteId) });
			}
			connect();
		});

		return () => {
			cancelled = true;
			appStateSub.remove();
			if (reconnectTimer) clearTimeout(reconnectTimer);
			close();
		};
	}, [qc, activeNoteId]);
};
