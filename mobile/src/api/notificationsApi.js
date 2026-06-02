import { Platform } from "react-native";
import axiosInstance from "./axiosInstance";

// Register this device's Expo push token with the backend.
export const registerExpoToken = async (token) => {
	await axiosInstance.post("/admin/notifications/expo-token", {
		token,
		platform: Platform.OS,
	});
};

export const deleteExpoToken = async (token) => {
	await axiosInstance.delete("/admin/notifications/expo-token", {
		data: { token },
	});
};

export const fetchPreferences = async () => {
	const { data } = await axiosInstance.get("/admin/notifications/preferences");
	return data; // { web_enabled, push_enabled }
};

export const updatePreferences = async (payload) => {
	const { data } = await axiosInstance.put(
		"/admin/notifications/preferences",
		payload,
	);
	return data;
};
