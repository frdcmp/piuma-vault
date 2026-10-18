import axiosInstance from "./axiosInstance";

// The vault's UI theme (global, single-tenant). Reading is public so the login
// screen and public share pages wear the theme too; writing needs admin_access.

export const getAppearance = async () => {
	const { data } = await axiosInstance.get("/settings/appearance");
	return data; // { theme: string | null }
};

export const updateAppearance = async (payload) => {
	const { data } = await axiosInstance.put(
		"/admin/settings/appearance",
		payload,
	);
	return data;
};
