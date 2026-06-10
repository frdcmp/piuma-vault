import axiosInstance from "./axiosInstance";

// Idle screen-lock — config is set on the web admin (Settings → Security). Mobile
// only reads it to know whether/when to lock, and verifies the PIN to unlock.
// The PIN is never returned; it's checked server-side against an argon2 hash.

export const getScreenLock = async () => {
	const { data } = await axiosInstance.get("/admin/settings/screen-lock");
	return data; // { enabled, timeout_seconds, pin_set }
};

export const verifyScreenLockPin = async (pin) => {
	const { data } = await axiosInstance.post(
		"/admin/settings/screen-lock/verify",
		{ pin },
	);
	return data; // { ok: boolean }
};
