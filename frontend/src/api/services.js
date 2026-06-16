import axiosInstance from "./axiosInstance";

// Service connection config (Azure embeddings, S3 storage, web search) stored in
// the DB. Secrets are write-only: GET returns `*_set` booleans, never the value.

export const getServices = async () => {
	const { data } = await axiosInstance.get("/admin/settings/services");
	return data;
};

export const updateServices = async (payload) => {
	const { data } = await axiosInstance.put("/admin/settings/services", payload);
	return data;
};

// Live "try now" checks. Resolve to { ok, message }. An optional payload tests
// unsaved form values; blank fields fall back to the saved config server-side.
export const testEmbedding = async (payload) => {
	const { data } = await axiosInstance.post(
		"/admin/settings/services/test/embedding",
		payload,
	);
	return data;
};

export const testStorage = async (payload) => {
	const { data } = await axiosInstance.post(
		"/admin/settings/services/test/storage",
		payload,
	);
	return data;
};

export const testWebsearch = async (payload) => {
	const { data } = await axiosInstance.post(
		"/admin/settings/services/test/websearch",
		payload,
	);
	return data;
};

export const testGithub = async (payload) => {
	const { data } = await axiosInstance.post(
		"/admin/settings/services/test/github",
		payload,
	);
	return data;
};

export const testTranscription = async (payload) => {
	const { data } = await axiosInstance.post(
		"/admin/settings/services/test/transcription",
		payload,
	);
	return data;
};

export const testImagegen = async (payload) => {
	const { data } = await axiosInstance.post(
		"/admin/settings/services/test/imagegen",
		payload,
	);
	return data;
};

// Lists the image-capable models the configured provider exposes for its key.
// Resolves to { models: string[], error? }.
export const imagegenModels = async (payload) => {
	const { data } = await axiosInstance.post(
		"/admin/settings/services/imagegen/models",
		payload,
	);
	return data;
};
