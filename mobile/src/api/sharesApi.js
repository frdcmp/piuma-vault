import axiosInstance from "./axiosInstance";

// ── Note share links ──────────────────────────────────────────────────────
// Mirrors the web app's frontend/src/api/shares.js so notes shared from the
// phone produce the exact same public links.

/**
 * Create a share link for a note.
 * POST /admin/notes/:id/share
 */
export const createShareLink = async (
	noteId,
	{ accessLevel, password, expiresInHours } = {},
) => {
	const { data } = await axiosInstance.post(`/admin/notes/${noteId}/share`, {
		access_level: accessLevel || "view",
		password: password || null,
		expires_in_hours: expiresInHours || null,
	});
	return data;
};

/**
 * List all share links for a note.
 * GET /admin/notes/:id/shares
 */
export const listShareLinks = async (noteId) => {
	const { data } = await axiosInstance.get(`/admin/notes/${noteId}/shares`);
	return data;
};

/**
 * Revoke a share link.
 * DELETE /admin/notes/shares/:shareId
 */
export const revokeShareLink = async (shareId) => {
	const { data } = await axiosInstance.delete(
		`/admin/notes/shares/${shareId}`,
	);
	return data;
};
