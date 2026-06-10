import axiosInstance from "./axiosInstance";

// The active mascot sprite (public endpoint) — { key, name, definition }.
export const getActiveSprite = async () => {
	const { data } = await axiosInstance.get("/sprites/active");
	return data;
};

// All mascots (admin). Each — { key, name, definition, is_builtin, active }.
export const listSprites = async () => {
	const { data } = await axiosInstance.get("/admin/sprites");
	return data;
};

// Pick which mascot is active. Mobile only sets the active one; create/edit of
// custom sprites stays on the web admin Appearance page.
export const setActiveSprite = async (key) => {
	const { data } = await axiosInstance.put("/admin/sprites/active", { key });
	return data;
};
