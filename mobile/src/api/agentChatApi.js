import { fetch } from "expo/fetch";
import { useAuthStore } from "../stores/authStore";
import axiosInstance, { refreshAccessToken } from "./axiosInstance";

// Agents chat client (mirrors the web one). CRUD via axiosInstance; the chat
// turn streams over expo/fetch, parsing our `data: {type,…}` SSE events.

const BASE_PATH =
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1";

export const fetchAgents = async () =>
	(await axiosInstance.get("/agents")).data;
export const fetchDefaultAgent = async () =>
	(await axiosInstance.get("/agents/default-agent")).data; // { agent }
export const createConversation = async (payload) =>
	(await axiosInstance.post("/agents/conversations", payload)).data;
export const fetchConversation = async (id) =>
	(await axiosInstance.get(`/agents/conversations/${id}`)).data;
export const fetchConversations = async (agent, q) =>
	(
		await axiosInstance.get("/agents/conversations", {
			params: { ...(agent ? { agent } : {}), ...(q ? { q } : {}) },
		})
	).data;
export const updateConversation = async ({ id, ...payload }) =>
	(await axiosInstance.patch(`/agents/conversations/${id}`, payload)).data;
export const deleteConversation = async (id) =>
	(await axiosInstance.delete(`/agents/conversations/${id}`)).data;
// Wipe a conversation's messages in place, keeping the same conversation id.
export const clearConversation = async (id) =>
	(await axiosInstance.delete(`/agents/conversations/${id}/messages`)).data;
// Force an AI re-title of a conversation; returns { title }.
export const retitleConversation = async (id) =>
	(await axiosInstance.post(`/agents/conversations/${id}/retitle`)).data;
// All enabled models across providers — for the /models picker.
export const fetchAllModels = async () =>
	(await axiosInstance.get("/agents/models")).data;

// STOP — cancel the conversation's running turn mid-stream.
export const stopConversation = async (id) =>
	(await axiosInstance.post(`/agents/conversations/${id}/stop`)).data;

// Switch the active branch: move the conversation's active leaf into the chosen
// sibling's subtree. Returns the new active path { conversation, messages }.
export const switchBranch = async (id, messageId) =>
	(
		await axiosInstance.post(`/agents/conversations/${id}/switch-branch`, {
			message_id: messageId,
		})
	).data;

// INJECT — queue a message into the running turn (consumed next round). Resolves
// `{ queued: true }`; a 409 means no turn is active (send via /chat instead).
export const injectMessage = async (id, message) =>
	(await axiosInstance.post(`/agents/conversations/${id}/inject`, { message }))
		.data;

// Device "now" as RFC3339 *with* the local UTC offset (e.g.
// "2026-06-05T14:52:00+02:00") — gives the agent a real clock + timezone.
const localNowIso = () => {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset(); // minutes east of UTC
	const sign = off >= 0 ? "+" : "-";
	const oh = p(Math.floor(Math.abs(off) / 60));
	const om = p(Math.abs(off) % 60);
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}:${om}`;
};

const localTimezone = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
	} catch {
		return null;
	}
};

const buildChatRequest = (
	conversationId,
	message,
	contextNoteIds,
	images,
	signal,
	branch,
) => {
	const token = useAuthStore.getState().token;
	const { regenerate, parentId, fork } = branch || {};
	return fetch(`${BASE_PATH}/agents/conversations/${conversationId}/chat`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({
			message,
			context_note_ids: contextNoteIds || [],
			images: images || [],
			timezone: localTimezone(),
			client_now: localNowIso(),
			regenerate: !!regenerate,
			fork: !!fork,
			...(parentId != null ? { parent_id: parentId } : {}),
		}),
		signal,
	});
};

/**
 * Stream a chat turn. Callbacks: onText(delta), onThinking(delta), onTool(evt),
 * onDone(meta), onError(err). Resolves when the stream closes.
 */
export async function streamChat({
	conversationId,
	message,
	contextNoteIds,
	images,
	signal,
	branch,
	onText,
	onThinking,
	onTool,
	onDone,
	onError,
}) {
	try {
		let resp = await buildChatRequest(
			conversationId,
			message,
			contextNoteIds,
			images,
			signal,
			branch,
		);
		if (resp.status === 401 && useAuthStore.getState().refreshToken) {
			try {
				await refreshAccessToken();
				resp = await buildChatRequest(
					conversationId,
					message,
					contextNoteIds,
					images,
					signal,
					branch,
				);
			} catch (refreshErr) {
				await useAuthStore.getState().logout();
				throw refreshErr;
			}
		}
		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`HTTP ${resp.status}: ${text || "request failed"}`);
		}

		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			while (true) {
				const idx = buffer.indexOf("\n\n");
				if (idx < 0) break;
				const event = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const line = event.split("\n").find((l) => l.startsWith("data:"));
				if (!line) continue;
				const data = line.slice(5).trim();
				if (!data) continue;
				try {
					const json = JSON.parse(data);
					if (json.type === "text") onText?.(json.delta || "");
					else if (json.type === "thinking") onThinking?.(json.delta || "");
					else if (json.type === "tool") onTool?.(json);
					else if (json.type === "done") onDone?.(json);
					else if (json.type === "error") onError?.(new Error(json.error));
				} catch {
					// keep-alive / non-JSON frame — ignore
				}
			}
		}
	} catch (e) {
		if (e?.name === "AbortError") return;
		// Transport-level drop (stream reset / connection abort), NOT a backend
		// error frame. The turn keeps running server-side and is persisted, so the
		// caller can recover by refetching. Tagged so it can tell the two apart.
		e.isTransport = true;
		onError?.(e);
	}
}
