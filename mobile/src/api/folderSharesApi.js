import axiosInstance from "./axiosInstance";

// ── Public folder share links ─────────────────────────────────────────────
// Mirrors the web app's frontend/src/api/folderShares.js (admin half). A folder
// share exposes a storage folder publicly at `<site>/s/<slug>` — view-only or a
// full read/write file manager — optionally password-protected and/or expiring.

// Create a public share for a storage folder. `prefix` is the folder key
// (e.g. "docs/"); access is "view" or "edit".
export const createFolderShare = async ({
	prefix,
	accessLevel = "view",
	password,
	expiresInHours,
} = {}) => {
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

// Revoke (delete) a folder share.
export const revokeFolderShare = async (id) => {
	const { data } = await axiosInstance.delete(`/admin/storage/shares/${id}`);
	return data;
};
