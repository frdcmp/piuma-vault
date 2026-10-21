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

// Start an AI generation job ({ name, prompt } → { id }). It runs server-side
// in rounds; each round is announced over SSE and listed by
// listSpriteGenerations. Nothing is saved until the admin picks a round.
export const generateSprite = async ({ name, prompt }) => {
	const { data } = await axiosInstance.post("/admin/sprites/generate", {
		name,
		prompt,
	});
	return data;
};

// Running and recent generation jobs, newest first, each with its rounds.
export const listSpriteGenerations = async () => {
	const { data } = await axiosInstance.get("/admin/sprites/generations");
	return data;
};

export const dismissSpriteGeneration = async (id) => {
	await axiosInstance.delete(`/admin/sprites/generations/${id}`);
};
