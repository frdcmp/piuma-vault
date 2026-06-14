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

// Kick off AI generation. The LLM call runs server-side for minutes, so this
// just starts the job and returns 202 immediately — the finished sprite is saved
// under { name, key } and broadcast over SSE, where the live-updates hook picks
// it up and it appears in the grid.
export const generateSprite = async ({ name, key, prompt }) => {
	const { data } = await axiosInstance.post("/admin/sprites/generate", {
		name,
		key,
		prompt,
	});
	return data;
};
