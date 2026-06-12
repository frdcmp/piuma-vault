import axiosInstance from "./axiosInstance";

// Recorder sessions. The live audio capture runs inside the embedded web
// `/recorder` scene (see RecorderScreen → WebView), because managed Expo can't
// stream raw PCM to the streaming backend. These REST calls power the native
// sessions list + transcript detail around it. Backend: rust/src/apps/recorder.

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

export const deleteRecording = async (id) => {
	const { data } = await axiosInstance.delete(`/recorder/sessions/${id}`);
	return data;
};

// The web app origin is the API base minus the `/api/v1` suffix — derived from
// the same env var axiosInstance uses so dev and prod stay in sync.
const API_BASE =
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1";

export const webOrigin = API_BASE.replace(/\/api\/v1\/?$/, "");

// The embedded recorder scene. WorkspaceLayout renders it bare (no chrome) when
// it detects the ReactNativeWebView bridge.
export const recorderEmbedUrl = () => `${webOrigin}/recorder`;
