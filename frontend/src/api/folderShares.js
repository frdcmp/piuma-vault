import axiosInstance from "./axiosInstance";

// ── Admin: manage folder shares (authed) ──────────────────────────

// Create a public share for a storage folder. `prefix` is the folder key
// (e.g. "projects/example/"); access is "view" or "edit".
export const createFolderShare = async ({
	prefix,
	accessLevel = "view",
	password,
	expiresInHours,
}) => {
	const { data } = await axiosInstance.post("/admin/storage/shares", {
		prefix,
		access_level: accessLevel,
		password: password || null,
		expires_in_hours: expiresInHours ?? null,
	});
	return data;
};

// List shares, optionally filtered to a single folder prefix.
export const listFolderShares = async (prefix) => {
	const { data } = await axiosInstance.get("/admin/storage/shares", {
		params: prefix ? { prefix } : {},
	});
	return data;
};

export const updateFolderShare = async (id, updates) => {
	const { data } = await axiosInstance.put(
		`/admin/storage/shares/${id}`,
		updates,
	);
	return data;
};

export const deleteFolderShare = async (id) => {
	const { data } = await axiosInstance.delete(`/admin/storage/shares/${id}`);
	return data;
};

// Renew: reset created_at to now and push expiry forward by its original lifespan.
export const renewFolderShare = async (id) => {
	const { data } = await axiosInstance.post(
		`/admin/storage/shares/${id}/renew`,
	);
	return data;
};

// ── Public: a slug-scoped client used by the public viewer (no auth) ──
// All paths are RELATIVE to the share root. `pwd` is appended when set.

const publicBase = (slug) => `/share/f/${encodeURIComponent(slug)}`;

const withPwd = (params = {}, pwd) => (pwd ? { ...params, pwd } : params);

export const getShareMeta = async (slug) => {
	const { data } = await axiosInstance.get(publicBase(slug));
	return data;
};

export const listShareFolder = async (slug, { path = "", pwd } = {}) => {
	const { data } = await axiosInstance.get(`${publicBase(slug)}/list`, {
		params: withPwd({ path }, pwd),
	});
	return data;
};

export const shareSignedUrl = async (slug, { path, pwd }) => {
	const { data } = await axiosInstance.post(
		`${publicBase(slug)}/signed-url`,
		{ path },
		{ params: withPwd({}, pwd) },
	);
	return data;
};

export const shareZip = async (slug, { path, pwd }) => {
	const { data } = await axiosInstance.post(
		`${publicBase(slug)}/zip`,
		{ path },
		{ params: withPwd({}, pwd) },
	);
	return data;
};

export const sharePresignUpload = async (slug, { path, contentType, pwd }) => {
	const { data } = await axiosInstance.post(
		`${publicBase(slug)}/upload`,
		{ path, content_type: contentType },
		{ params: withPwd({}, pwd) },
	);
	return data;
};

export const shareDeleteObject = async (slug, { path, pwd }) => {
	const { data } = await axiosInstance.delete(`${publicBase(slug)}/object`, {
		data: { path },
		params: withPwd({}, pwd),
	});
	return data;
};

export const shareDeleteFolder = async (slug, { path, pwd }) => {
	const { data } = await axiosInstance.delete(`${publicBase(slug)}/folder`, {
		data: { path },
		params: withPwd({}, pwd),
	});
	return data;
};

export const shareCreateFolder = async (slug, { path, pwd }) => {
	const { data } = await axiosInstance.post(
		`${publicBase(slug)}/folder`,
		{ path },
		{ params: withPwd({}, pwd) },
	);
	return data;
};

export const shareMove = async (slug, { from, to, pwd }) => {
	const { data } = await axiosInstance.post(
		`${publicBase(slug)}/move`,
		{ from, to },
		{ params: withPwd({}, pwd) },
	);
	return data;
};
