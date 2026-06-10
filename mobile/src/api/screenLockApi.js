import axiosInstance from "./axiosInstance";

// Idle screen-lock — config is set on the web admin (Settings → Security). Mobile
// only reads it to know whether/when to lock, and verifies the PIN to unlock.
// The PIN is never returned; it's checked server-side against an argon2 hash.

export const getScreenLock = async () => {
	const { data } = await axiosInstance.get("/admin/settings/screen-lock");
	return data; // { enabled, timeout_seconds, pin_set }
};

// Update the config. Partial payloads are fine: { enabled }, { timeout_seconds }
// or { pin } (6 digits). The PUT returns the fresh config.
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
