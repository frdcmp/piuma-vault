import axiosInstance from "./axiosInstance";

// ── Notes CRUD ────────────────────────────────────────────────────────────

export const fetchNotes = async (params = {}) => {
	const { data } = await axiosInstance.get("/admin/notes", { params });
	return data;
};

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const fetchNote = async (id) => {
	if (!UUID_RE.test(id)) {
		throw new Error(`Invalid note ID: ${id}`);
	}
	const { data } = await axiosInstance.get(`/admin/notes/${id}`);
	return data;
};

export const createNote = async (payload) => {
	const { data } = await axiosInstance.post("/admin/notes", payload);
	return data;
};

export const updateNote = async ({ id, ...payload }) => {
	if (!UUID_RE.test(id)) {
		throw new Error(`Invalid note ID for update: ${id}`);
	}
	const { data } = await axiosInstance.put(`/admin/notes/${id}`, payload);
	return data;
};

// Soft delete — moves the note to the trash (sets deleted_at server-side). The
// note keeps its content, folder and attachments and can be restored.
export const deleteNote = async (id) => {
	if (!UUID_RE.test(id)) {
		throw new Error(`Invalid note ID for delete: ${id}`);
	}
	const { data } = await axiosInstance.delete(`/admin/notes/${id}`);
	return data;
};

// ── Trash ─────────────────────────────────────────────────────────────────

export const fetchTrash = async (params = {}) => {
	const { data } = await axiosInstance.get("/admin/notes/trash", { params });
	return data;
};

export const restoreNote = async (id) => {
	if (!UUID_RE.test(id)) {
		throw new Error(`Invalid note ID for restore: ${id}`);
	}
	const { data } = await axiosInstance.put(`/admin/notes/${id}/restore`);
	return data;
};

// Permanent delete — removes the note for good and purges its S3 attachments.
export const permanentlyDeleteNote = async (id) => {
	if (!UUID_RE.test(id)) {
		throw new Error(`Invalid note ID for permanent delete: ${id}`);
	}
	const { data } = await axiosInstance.delete(`/admin/notes/${id}/permanent`);
	return data;
};

// Permanently delete every note currently in the trash.
export const emptyTrash = async () => {
	const { data } = await axiosInstance.delete("/admin/notes/trash");
	return data;
};

// ── Metadata ──────────────────────────────────────────────────────────────

export const fetchTags = async () => {
	const { data } = await axiosInstance.get("/admin/notes/tags");
	return data;
};

export const fetchFolders = async () => {
	const { data } = await axiosInstance.get("/admin/notes/folders");
	return data;
};

export const searchFolders = async (q, limit = 20) => {
	const { data } = await axiosInstance.get("/admin/notes/folders/search", {
		params: { q, limit },
	});
	return data;
};

// Folders are ephemeral — renaming/moving one bulk-rewrites the `folder` path
// prefix on every note under `from` (and its subfolders) to `to`.
export const renameFolder = async ({ from, to }) => {
	const { data } = await axiosInstance.put("/admin/notes/folders/rename", {
		from,
		to,
	});
	return data;
};

// ── Browse (lazy-load) ────────────────────────────────────────────────────

export const browseFolder = async (path = "/") => {
	const { data } = await axiosInstance.get("/admin/notes/browse", {
		params: { path },
	});
	return data;
};
