import axiosInstance from "./axiosInstance";

// User-managed email accounts (Services → Email). Each account can independently
// enable SMTP send and/or IMAP read. Passwords are write-only: list returns
// `smtp_password_set` / `imap_password_set` booleans, never the value.

export const listEmailAccounts = async () => {
	const { data } = await axiosInstance.get("/admin/email/accounts");
	return data;
};

export const createEmailAccount = async (payload) => {
	const { data } = await axiosInstance.post("/admin/email/accounts", payload);
	return data;
};

export const updateEmailAccount = async ({ id, ...payload }) => {
	const { data } = await axiosInstance.put(
		`/admin/email/accounts/${id}`,
		payload,
	);
	return data;
};

export const deleteEmailAccount = async (id) => {
	const { data } = await axiosInstance.delete(`/admin/email/accounts/${id}`);
	return data;
};

export const setDefaultEmailAccount = async (id) => {
	const { data } = await axiosInstance.post(
		`/admin/email/accounts/${id}/default`,
	);
	return data;
};

// Live connection checks. Resolve to { ok, message }. The payload may reference
// a saved account by `id` and/or carry unsaved form overrides; a blank password
// falls back to the stored secret server-side.
export const testEmailSmtp = async (payload) => {
	const { data } = await axiosInstance.post(
		"/admin/email/accounts/test/smtp",
		payload,
	);
	return data;
};

export const testEmailImap = async (payload) => {
	const { data } = await axiosInstance.post(
		"/admin/email/accounts/test/imap",
		payload,
	);
	return data;
};
