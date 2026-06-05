import axiosInstance from "./axiosInstance";

// ── Buckets ───────────────────────────────────────────────────────────────────

export const fetchBuckets = async () => {
	const { data } = await axiosInstance.get("/admin/buckets");
	return data;
};

export const createBucket = async (payload) => {
	const { data } = await axiosInstance.post("/admin/buckets", payload);
	return data;
};

export const updateBucket = async ({ id, ...payload }) => {
	const { data } = await axiosInstance.put(`/admin/buckets/${id}`, payload);
	return data;
};

export const deleteBucket = async (id) => {
	const { data } = await axiosInstance.delete(`/admin/buckets/${id}`);
	return data;
};

// ── Tags ────────────────────────────────────────────────────────────────────

export const fetchTags = async () => {
	const { data } = await axiosInstance.get("/admin/tags");
	return data;
};

// scope: "tasks" | "calendar" | undefined — which surface to count usage against.
export const fetchTagTree = async (scope) => {
	const { data } = await axiosInstance.get("/admin/tags/tree", {
		params: scope ? { counts: scope } : {},
	});
	return data;
};

export const createTag = async (payload) => {
	const { data } = await axiosInstance.post("/admin/tags", payload);
	return data;
};

export const updateTag = async ({ id, ...payload }) => {
	const { data } = await axiosInstance.put(`/admin/tags/${id}`, payload);
	return data;
};

export const deleteTag = async (id) => {
	const { data } = await axiosInstance.delete(`/admin/tags/${id}`);
	return data;
};
