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

export const notesKeys = {
	all: ["notes"],
	list: (params) => ["notes", "list", params],
	detail: (id) => ["notes", "detail", id],
	tags: () => ["notes", "tags"],
	folders: () => ["notes", "folders"],
	browse: (path) => ["notes", "browse", path],
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
		onSuccess: (data) => {
			// Pre-populate the cache for this newly created note
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
		onSuccess: (data) => {
			// Update cache for the specific note
			qc.setQueryData(notesKeys.detail(data.id), data);
			// Invalidate list to reflect changes
			qc.invalidateQueries({ queryKey: ["notes", "list"] });
		},
	});
};

// ── Delete ────────────────────────────────────────────────────────────────

export const useDeleteNote = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteNote,
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

		const handleNoteEvent = (evt) => {
			let payload;
			try {
				payload = JSON.parse(evt.data);
			} catch {
				return;
			}

			qc.invalidateQueries({ queryKey: ["notes", "list"] });
			// The folder tree is driven by browse(path) queries — invalidate the
			// whole browse family so create/rename/move/delete refresh it.
			qc.invalidateQueries({ queryKey: ["notes", "browse"] });

			if (!payload?.id) return;

			if (payload.action === "deleted") {
				qc.removeQueries({ queryKey: notesKeys.detail(payload.id) });
			} else if (activeNoteId && payload.id === activeNoteId) {
				qc.invalidateQueries({ queryKey: notesKeys.detail(payload.id) });
			} else {
				qc.invalidateQueries({
					queryKey: notesKeys.detail(payload.id),
					refetchType: "none",
				});
			}
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
