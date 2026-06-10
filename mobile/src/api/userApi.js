import axiosInstance from "./axiosInstance";

// The signed-in user + profile (first/last name, location, bio, …) plus account
// flags (otp_enabled, groups, permissions, created_at).
export const fetchUserMe = async () => {
	const { data } = await axiosInstance.get("/auth/me");
	return data;
};

// Partial profile update. The backend COALESCEs nulls, so only the fields you
// send are changed.
export const updateUserProfile = async (payload) => {
	const { data } = await axiosInstance.put("/auth/profile", payload);
	return data;
};
