import { useAuthStore } from "../stores/authStore";
import axiosInstance from "./axiosInstance";

// Recorder sessions. Live capture is now FULLY NATIVE: the device streams raw
// PCM16 @ 16 kHz to the backend relay over a WebSocket (see useRecorderStream),
// exactly like the web app — no WebView. These REST calls manage the session
// rows around that socket. Backend: rust/src/apps/recorder.

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

// Create a session row, then capture into it. Returns { session_id, ws_path,
// sample_rate } — ws_path is relative (no /api/v1 prefix; that's added below).
export const createRecording = async (payload) => {
	const { data } = await axiosInstance.post("/recorder/sessions", payload ?? {});
	return data;
};

export const deleteRecording = async (id) => {
	const { data } = await axiosInstance.delete(`/recorder/sessions/${id}`);
	return data;
};

// Run the deferred summary on a saved ('ready') transcript → creates/refreshes
// the vault note and flips the session to 'done'.
export const summariseRecording = async (id) => {
	const { data } = await axiosInstance.post(
		`/recorder/sessions/${id}/summarise`,
	);
	return data;
};

// Merge this session's transcript into `targetId` and re-summarise the target.
export const appendRecording = async ({ id, targetId }) => {
	const { data } = await axiosInstance.post(`/recorder/sessions/${id}/append`, {
		target_id: targetId,
	});
	return data;
};

// The API base already includes `/api/v1` (or EXPO_PUBLIC_API_URL does).
const API_BASE =
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1";

// Absolute WebSocket URL for a session's relay. The backend hands back a
// relative `ws_path` (`/recorder/sessions/{id}/ws`); we swap the http(s) scheme
// for ws(s) on the API base and carry the access token as a query param (WS
// can't set headers — same trick the web client uses).
export const recorderWsUrl = (wsPath, token) => {
	const jwt = token ?? useAuthStore.getState().token ?? "";
	const wsBase = API_BASE.replace(/^http/, "ws").replace(/\/+$/, "");
	return `${wsBase}${wsPath}?token=${encodeURIComponent(jwt)}`;
};
