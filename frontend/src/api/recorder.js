import axiosInstance from "./axiosInstance";

// Recorder sessions. The streaming audio path is a WebSocket (see RecorderPage);
// these REST calls manage the session rows around it.

export const listRecordings = async () => {
	const { data } = await axiosInstance.get("/recorder/sessions");
	return data;
};

export const getRecording = async (id) => {
	const { data } = await axiosInstance.get(`/recorder/sessions/${id}`);
	return data;
};

export const getRecordingTranscript = async (id) => {
	const { data } = await axiosInstance.get(
		`/recorder/sessions/${id}/transcript`,
	);
	return data;
};

export const getRecorderUsage = async () => {
	const { data } = await axiosInstance.get("/recorder/usage");
	return data;
};

export const createRecording = async (payload) => {
	const { data } = await axiosInstance.post(
		"/recorder/sessions",
		payload ?? {},
	);
	return data;
};

export const stopRecording = async (id) => {
	const { data } = await axiosInstance.post(`/recorder/sessions/${id}/stop`);
	return data;
};

export const renameRecording = async ({ id, title }) => {
	const { data } = await axiosInstance.post(`/recorder/sessions/${id}/title`, {
		title,
	});
	return data;
};

export const deleteRecording = async (id) => {
	const { data } = await axiosInstance.delete(`/recorder/sessions/${id}`);
	return data;
};

// Build the absolute WebSocket URL for a session's relay, carrying the access
// token as a query param (the browser WebSocket API can't set headers).
export const recorderWsUrl = (wsPath) => {
	const token = localStorage.getItem("token") ?? "";
	const proto = window.location.protocol === "https:" ? "wss" : "ws";
	const base = `${import.meta.env.BASE_URL}api/v1`.replace(/\/+/g, "/");
	return `${proto}://${window.location.host}${base}${wsPath}?token=${encodeURIComponent(token)}`;
};
