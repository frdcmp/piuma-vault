import axiosInstance from "./axiosInstance";

// ── Tasks ───────────────────────────────────────────────────────────────────

export const fetchTasks = async (params = {}) => {
	const { data } = await axiosInstance.get("/admin/tasks", { params });
	return data;
};

export const fetchTask = async (id) => {
	const { data } = await axiosInstance.get(`/admin/tasks/${id}`);
	return data;
};

export const createTask = async (payload) => {
	const { data } = await axiosInstance.post("/admin/tasks", payload);
	return data;
};

export const updateTask = async ({ id, ...payload }) => {
	const { data } = await axiosInstance.put(`/admin/tasks/${id}`, payload);
	return data;
};

export const toggleTask = async (id) => {
	const { data } = await axiosInstance.put(`/admin/tasks/${id}/toggle`);
	return data;
};

export const deleteTask = async (id) => {
	const { data } = await axiosInstance.delete(`/admin/tasks/${id}`);
	return data;
};

// ── Recurring-task templates ──────────────────────────────────────────────────

export const fetchRecurringTasks = async () => {
	const { data } = await axiosInstance.get("/admin/recurring-tasks");
	return data;
};

export const createRecurringTask = async (payload) => {
	const { data } = await axiosInstance.post("/admin/recurring-tasks", payload);
	return data;
};

export const updateRecurringTask = async ({ id, ...payload }) => {
	const { data } = await axiosInstance.put(
		`/admin/recurring-tasks/${id}`,
		payload,
	);
	return data;
};

export const deleteRecurringTask = async (id) => {
	const { data } = await axiosInstance.delete(`/admin/recurring-tasks/${id}`);
	return data;
};

// Mark (or unmark) a single recurring-task occurrence complete. `date` is the
// local "YYYY-MM-DD" of the occurrence; the backend materializes/removes the row.
export const completeOccurrence = async ({
	recurrenceId,
	date,
	done = true,
}) => {
	const { data } = await axiosInstance.put(
		`/admin/recurring-tasks/${recurrenceId}/occurrences/${date}/complete`,
		{ done },
	);
	return data;
};
