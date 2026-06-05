import { fetch } from "expo/fetch";
import { useAuthStore } from "../stores/authStore";
import axiosInstance, { refreshAccessToken } from "./axiosInstance";

// Agents chat client (mirrors the web one). CRUD via axiosInstance; the chat
// turn streams over expo/fetch, parsing our `data: {type,…}` SSE events.

const BASE_PATH =
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1";

export const fetchAgents = async () => (await axiosInstance.get("/agents")).data;
export const fetchDefaultAgent = async () =>
	(await axiosInstance.get("/agents/default-agent")).data; // { agent }
export const createConversation = async (payload) =>
	(await axiosInstance.post("/agents/conversations", payload)).data;
export const fetchConversation = async (id) =>
	(await axiosInstance.get(`/agents/conversations/${id}`)).data;

const buildChatRequest = (conversationId, message, contextNoteIds, signal) => {
	const token = useAuthStore.getState().token;
	return fetch(`${BASE_PATH}/agents/conversations/${conversationId}/chat`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ message, context_note_ids: contextNoteIds || [] }),
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
	signal,
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
			signal,
		);
		if (resp.status === 401 && useAuthStore.getState().refreshToken) {
			try {
				await refreshAccessToken();
				resp = await buildChatRequest(
					conversationId,
					message,
					contextNoteIds,
					signal,
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
		onError?.(e);
	}
}
