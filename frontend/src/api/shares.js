import axiosInstance from "./axiosInstance";

/**
 * Create a share link for a note.
 * POST /admin/notes/:id/share
 */
export async function createShareLink(
	noteId,
	{ accessLevel, password, expiresInHours },
) {
	const res = await axiosInstance.post(`/admin/notes/${noteId}/share`, {
		access_level: accessLevel || "view",
		password: password || null,
		expires_in_hours: expiresInHours || null,
	});
	return res.data;
}

/**
 * List all share links for a note.
 * GET /admin/notes/:id/shares
 */
export async function listShareLinks(noteId) {
	const res = await axiosInstance.get(`/admin/notes/${noteId}/shares`);
	return res.data;
}

/**
 * List every note share across all notes (central admin Shares page).
 * GET /admin/shares
 */
export async function listAllShareLinks() {
	const res = await axiosInstance.get("/admin/shares");
	return res.data;
}

/**
 * Update share settings.
 * PUT /admin/notes/shares/:shareId
 */
export async function updateShareLink(shareId, updates) {
	const res = await axiosInstance.put(
		`/admin/notes/shares/${shareId}`,
		updates,
	);
	return res.data;
}

/**
 * Revoke a share link.
 * DELETE /admin/notes/shares/:shareId
 */
export async function revokeShareLink(shareId) {
	const res = await axiosInstance.delete(`/admin/notes/shares/${shareId}`);
	return res.data;
}

/**
 * Renew a share: reset created_at to now and push expiry forward by its
 * original lifespan. POST /admin/notes/shares/:shareId/renew
 */
export async function renewShareLink(shareId) {
	const res = await axiosInstance.post(`/admin/notes/shares/${shareId}/renew`);
	return res.data;
}

/**
 * Public: fetch a shared note as JSON.
 * GET /share/v/:slug?format=json[&pwd=...]
 *
 * Uses raw fetch (not axiosInstance) so the global 401 interceptor doesn't
 * redirect unauthenticated visitors to the admin login when a password is
 * required or wrong.
 */
export async function fetchSharedNote(slug, password) {
	const params = new URLSearchParams({ format: "json" });
	if (password) params.set("pwd", password);
	const base = import.meta.env.BASE_URL || "/";
	const url = `${base}api/v1/share/v/${encodeURIComponent(slug)}?${params}`;
	const res = await fetch(url, { credentials: "omit" });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const error = new Error(data?.error || `Request failed (${res.status})`);
		error.status = res.status;
		throw error;
	}
	return data;
}
