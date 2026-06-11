import axiosInstance from "./axiosInstance";

// Mascot sprites stored in the DB. The active one is public (rendered pre-login);
// the rest is admin CRUD + selecting which mascot is active.

// Public — { key, name, definition }.
export const getActiveSprite = async () => {
	const { data } = await axiosInstance.get("/sprites/active");
	return data;
};

export const listSprites = async () => {
	const { data } = await axiosInstance.get("/admin/sprites");
	return data;
};

export const createSprite = async (payload) => {
	const { data } = await axiosInstance.post("/admin/sprites", payload);
	return data;
};

export const updateSprite = async ({ key, ...payload }) => {
	const { data } = await axiosInstance.put(`/admin/sprites/${key}`, payload);
	return data;
};

export const deleteSprite = async (key) => {
	const { data } = await axiosInstance.delete(`/admin/sprites/${key}`);
	return data;
};

export const setActiveSprite = async (key) => {
	const { data } = await axiosInstance.put("/admin/sprites/active", { key });
	return data;
};

// AI-generate a sprite definition from a prompt. Returns { definition } —
// unsaved, for the editor to load so the admin can review/tweak before saving.
// Reasoning models routinely run past the default 2-min client timeout, so we
// give this one call a longer budget (kept under nginx's 300s proxy timeout).
export const generateSprite = async (prompt) => {
	const { data } = await axiosInstance.post(
		"/admin/sprites/generate",
		{ prompt },
		{ timeout: 280000 },
	);
	return data;
};
