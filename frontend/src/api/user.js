import axiosInstance from "./axiosInstance";

export const fetchUserMe = async () => {
	const { data } = await axiosInstance.get("/auth/me");
	return data;
};

export const updateUserProfile = async (profileData) => {
	const { data } = await axiosInstance.put("/auth/profile", profileData);
	return data;
};
