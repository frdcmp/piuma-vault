import axiosInstance from "./axiosInstance";

// Scheduled autonomous agent jobs. The cron-worker executes them; these REST
// calls manage definitions + expose run history. All under /admin/cron.

export const listCronJobs = async () => {
	const { data } = await axiosInstance.get("/admin/cron/jobs");
	return data;
};

export const getCronJob = async (id) => {
	const { data } = await axiosInstance.get(`/admin/cron/jobs/${id}`);
	return data; // { job, runs }
};

export const createCronJob = async (payload) => {
	const { data } = await axiosInstance.post("/admin/cron/jobs", payload);
	return data;
};

export const updateCronJob = async ({ id, ...payload }) => {
	const { data } = await axiosInstance.put(`/admin/cron/jobs/${id}`, payload);
	return data;
};

export const deleteCronJob = async (id) => {
	const { data } = await axiosInstance.delete(`/admin/cron/jobs/${id}`);
	return data;
};

export const runCronJobNow = async (id) => {
	const { data } = await axiosInstance.post(`/admin/cron/jobs/${id}/run-now`);
	return data;
};

export const toggleCronJob = async (id) => {
	const { data } = await axiosInstance.post(`/admin/cron/jobs/${id}/toggle`);
	return data;
};

export const listCronRuns = async (id) => {
	const { data } = await axiosInstance.get(`/admin/cron/jobs/${id}/runs`);
	return data;
};
