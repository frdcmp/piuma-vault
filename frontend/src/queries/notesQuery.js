import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
	browseFolder,
	createNote,
	deleteNote,
	emptyTrash,
	fetchFolders,
	fetchNote,
	fetchNotes,
	fetchTags,
	fetchTrash,
	permanentlyDeleteNote,
	renameFolder,
	restoreNote,
	searchFolders,
	updateNote,
} from "../api/notesApi";

export const notesKeys = {
	all: ["notes"],
	list: (params) => ["notes", "list", params],
	detail: (id) => ["notes", "detail", id],
	tags: () => ["notes", "tags"],
	folders: () => ["notes", "folders"],
	browse: (path) => ["notes", "browse", path],
	trash: () => ["notes", "trash"],
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
			// Invalidate all notes queries (list + browse tree) so renames
			// and other edits show up in the file explorer immediately.
			qc.invalidateQueries({ queryKey: notesKeys.all });
		},
	});
};

// ── Delete ────────────────────────────────────────────────────────────────

export const useDeleteNote = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteNote,
		onSuccess: (_data, id) => {
			// Soft delete — drop the detail cache and refresh lists + trash.
			qc.removeQueries({ queryKey: notesKeys.detail(id) });
			qc.invalidateQueries({ queryKey: notesKeys.all });
		},
	});
};

// ── Trash ─────────────────────────────────────────────────────────────────

export const useTrash = (params = {}, options = {}) =>
	useQuery({
		queryKey: notesKeys.trash(),
		queryFn: () => fetchTrash(params),
		staleTime: 30_000,
		...options,
	});

export const useRestoreNote = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: restoreNote,
		onSuccess: () => {
			// Note is live again — refresh the tree/lists and the trash list.
			qc.invalidateQueries({ queryKey: notesKeys.all });
		},
	});
};

export const usePermanentlyDeleteNote = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: permanentlyDeleteNote,
		onSuccess: (_data, id) => {
			qc.removeQueries({ queryKey: notesKeys.detail(id) });
			qc.invalidateQueries({ queryKey: notesKeys.trash() });
		},
	});
};

export const useEmptyTrash = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: emptyTrash,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: notesKeys.trash() });
		},
	});
};

// ── Rename folder (bulk path rewrite) ─────────────────────────────────────

export const useRenameFolder = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: renameFolder,
		onSuccess: () => {
			// Folder paths changed across many notes — refresh the whole tree.
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

export const useSearchFolders = (q, limit = 20, options = {}) =>
	useQuery({
		queryKey: ["notes", "folders", "search", q],
		queryFn: () => searchFolders(q, limit),
		staleTime: 30_000,
		...options,
	});

// ── Browse (lazy-load directory) ──────────────────────────────────────────

export const useBrowseFolder = (path) =>
	useQuery({
		queryKey: notesKeys.browse(path),
		queryFn: () => browseFolder(path),
		enabled: !!path,
		staleTime: 30_000,
	});

// ── Live updates (SSE) ───────────────────────────────────────────────────
//
// Subscribes to the backend notes event stream. On any mutation — from this
// tab, another tab, the mobile app, an LLM hitting a share link, or an
// integration using an x-api-key — invalidates the notes list and, when the
// changed note matches `activeNoteId`, the detail query as well.
//
// Native EventSource auto-reconnects on transient TCP drops, but it gives up
// on HTTP errors (most commonly 401 once the JWT expires mid-session). This
// hook layers manual reconnect on top: on a permanent close it tries to
// refresh the access token, then reopens the stream with exponential backoff,
// and invalidates queries on each successful reconnect to catch up on events
// that fired during the gap.
export const useNotesLiveUpdates = (activeNoteId) => {
	const qc = useQueryClient();

	useEffect(() => {
		let es = null;
		let reconnectTimer = null;
		let attempts = 0;
		let cancelled = false;

		const base = `${import.meta.env.BASE_URL}api/v1`;

		const tryRefreshToken = async () => {
			const refreshToken = localStorage.getItem("refreshToken");
			if (!refreshToken) return false;
			try {
				const res = await fetch(`${base}/auth/refresh`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ refresh_token: refreshToken }),
				});
				if (!res.ok) return false;
				const data = await res.json();
				if (data?.access_token) {
					localStorage.setItem("token", data.access_token);
				}
				if (data?.refresh_token) {
					localStorage.setItem("refreshToken", data.refresh_token);
				}
				return !!data?.access_token;
			} catch {
				return false;
			}
		};

		const handleNoteEvent = (evt) => {
			let payload;
			try {
				payload = JSON.parse(evt.data);
			} catch {
				return;
			}

			qc.invalidateQueries({ queryKey: ["notes", "list"] });
			// The sidebar tree is driven by browse(path) queries — invalidate
			// the whole browse family so create/rename/move/delete refresh it.
			qc.invalidateQueries({ queryKey: ["notes", "browse"] });
			// A delete/restore/purge anywhere changes the trash too.
			qc.invalidateQueries({ queryKey: notesKeys.trash() });

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

		const connect = () => {
			if (cancelled) return;

			const token = localStorage.getItem("token");
			if (!token) return; // logged out — nothing to listen to

			const url = `${base}/admin/notes/events?token=${encodeURIComponent(token)}`;
			es = new EventSource(url);

			es.addEventListener("note", handleNoteEvent);

			es.addEventListener("open", () => {
				if (attempts > 0) {
					// Reconnected after a drop — events fired during the gap are
					// gone, so refetch what the user is actually looking at.
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

			es.onerror = async () => {
				// Native EventSource handles transient TCP drops on its own —
				// only step in once it has permanently closed (HTTP error, most
				// commonly 401).
				if (cancelled || !es) return;
				if (es.readyState !== EventSource.CLOSED) return;

				console.warn("[notes SSE] stream closed; will reconnect");
				es.close();
				es = null;
				attempts += 1;

				// First failure on an established session almost always means
				// the access token aged out. Try refreshing before reconnecting
				// so we don't burn the backoff window on guaranteed-401s.
				if (attempts === 1) {
					await tryRefreshToken();
					if (cancelled) return;
				}

				// 1s, 2s, 4s, 8s, 16s, then capped at 30s. Indefinite — if the
				// user is logged out for real, axios's 401 handler on any other
				// request will navigate them to /login and unmount this hook.
				const delay = Math.min(30_000, 1000 * 2 ** (attempts - 1));
				reconnectTimer = setTimeout(connect, delay);
			};
		};

		connect();

		return () => {
			cancelled = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (es) es.close();
		};
	}, [qc, activeNoteId]);
};
