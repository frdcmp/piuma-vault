import axiosInstance from "./axiosInstance";

// Idle screen-lock config (global, single-tenant) stored in the DB. The PIN is
// write-only: GET returns `pin_set`, never the value. `verifyScreenLockPin`
// checks a PIN against the server-side argon2 hash (rate-limited).

export const getScreenLock = async () => {
	const { data } = await axiosInstance.get("/admin/settings/screen-lock");
	return data;
};

export const updateScreenLock = async (payload) => {
	const { data } = await axiosInstance.put(
		"/admin/settings/screen-lock",
		payload,
	);
	return data;
};

export const verifyScreenLockPin = async (pin) => {
	const { data } = await axiosInstance.post(
		"/admin/settings/screen-lock/verify",
		{ pin },
	);
	return data; // { ok: boolean }
};
