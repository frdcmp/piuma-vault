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

export const deleteNote = async (id) => {
	if (!UUID_RE.test(id)) {
		throw new Error(`Invalid note ID for delete: ${id}`);
	}
	const { data } = await axiosInstance.delete(`/admin/notes/${id}`);
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
