import axiosInstance from "./axiosInstance";

// The active mascot sprite (public endpoint) — { key, name, definition }.
export const getActiveSprite = async () => {
	const { data } = await axiosInstance.get("/sprites/active");
	return data;
};
