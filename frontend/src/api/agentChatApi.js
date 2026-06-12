import axiosInstance from "./axiosInstance";

// CRUD goes through axiosInstance (auth + refresh interceptors). The streaming
// chat turn uses a raw fetch (SSE), parsing our `data: {type,…}` events.

const BASE_PATH = `${import.meta.env.BASE_URL}api/v1`;

// ── Agents ───────────────────────────────────────────────────────────────────
export const fetchAgents = async () =>
	(await axiosInstance.get("/agents")).data;

export const fetchDefaultAgent = async () =>
	(await axiosInstance.get("/agents/default-agent")).data; // { agent }
export const setDefaultAgent = async (agent) =>
	(await axiosInstance.put("/agents/default-agent", { agent })).data;

// ── Providers ────────────────────────────────────────────────────────────────
export const fetchProviders = async () =>
	(await axiosInstance.get("/agents/providers")).data;
export const createProvider = async (payload) =>
	(await axiosInstance.post("/agents/providers", payload)).data;
export const updateProvider = async ({ id, ...payload }) =>
	(await axiosInstance.patch(`/agents/providers/${id}`, payload)).data;
export const deleteProvider = async (id) =>
	(await axiosInstance.delete(`/agents/providers/${id}`)).data;

// ── Models ───────────────────────────────────────────────────────────────────
export const fetchModels = async (providerId) =>
	(await axiosInstance.get(`/agents/providers/${providerId}/models`)).data;
// Live model catalog from the provider's own API — { models: [wireId, …] }.
export const fetchAvailableModels = async (providerId) =>
	(await axiosInstance.get(`/agents/providers/${providerId}/available-models`))
		.data;
export const createModel = async ({ providerId, ...payload }) =>
	(await axiosInstance.post(`/agents/providers/${providerId}/models`, payload))
		.data;
export const updateModel = async ({ id, ...payload }) =>
	(await axiosInstance.patch(`/agents/models/${id}`, payload)).data;
export const deleteModel = async (id) =>
	(await axiosInstance.delete(`/agents/models/${id}`)).data;

// ── Agent config (profile + personas) ───────────────────────────────────────
export const fetchProfile = async (agent) =>
	(await axiosInstance.get(`/agents/${agent}/profile`)).data;
export const updateProfile = async ({ agent, ...payload }) =>
	(await axiosInstance.patch(`/agents/${agent}/profile`, payload)).data;
export const fetchPersonas = async (agent) =>
	(await axiosInstance.get(`/agents/${agent}/personas`)).data;
export const updatePersona = async ({ id, ...payload }) =>
	(await axiosInstance.patch(`/agents/personas/${id}`, payload)).data;

// ── Conversations ────────────────────────────────────────────────────────────
export const fetchConversations = async (agent, q) =>
	(
		await axiosInstance.get("/agents/conversations", {
			params: { ...(agent ? { agent } : {}), ...(q ? { q } : {}) },
		})
	).data;
export const createConversation = async (payload) =>
	(await axiosInstance.post("/agents/conversations", payload)).data;
export const fetchConversation = async (id) =>
	(await axiosInstance.get(`/agents/conversations/${id}`)).data;
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

// STOP — cancel the conversation's running turn mid-stream.
export const stopConversation = async (id) =>
	(await axiosInstance.post(`/agents/conversations/${id}/stop`)).data;

// INJECT — queue a message into the running turn (consumed next round). A 409
// means no turn is active (the caller should send via /chat instead).
export const injectMessage = async (id, message) =>
	(await axiosInstance.post(`/agents/conversations/${id}/inject`, { message }))
		.data;

// All enabled models across providers — for the /models command picker.
export const fetchAllModels = async () =>
	(await axiosInstance.get("/agents/models")).data;

// ── Streaming chat (SSE) ─────────────────────────────────────────────────────

async function refreshAccessToken() {
	const refreshToken = localStorage.getItem("refreshToken");
	if (!refreshToken) throw new Error("No refresh token");
	const resp = await fetch(`${BASE_PATH}/auth/refresh`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refresh_token: refreshToken }),
	});
	if (!resp.ok) throw new Error(`refresh failed ${resp.status}`);
	const data = await resp.json();
	localStorage.setItem("token", data.access_token);
	localStorage.setItem("refreshToken", data.refresh_token);
	return data.access_token;
}

// Local "now" as RFC3339 *with* the browser's UTC offset (e.g.
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
) => {
	const token = localStorage.getItem("token");
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
		}),
		signal,
	});
};

/**
 * Stream a chat turn. Callbacks: onText(delta), onThinking(delta), onDone(meta),
 * onError(err). Returns when the stream closes.
 */
export async function streamChat({
	conversationId,
	message,
	contextNoteIds,
	images,
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
			images,
			signal,
		);
		if (resp.status === 401 && localStorage.getItem("refreshToken")) {
			try {
				await refreshAccessToken();
				resp = await buildChatRequest(
					conversationId,
					message,
					contextNoteIds,
					images,
					signal,
				);
			} catch (refreshErr) {
				localStorage.removeItem("token");
				localStorage.removeItem("refreshToken");
				throw refreshErr;
			}
		}
		if (!resp.ok) {
			// A non-2xx response is a real backend rejection (bad provider, no
			// model, no key, …), NOT a transport drop — the request completed.
			// Surface its message as a hard error so it shows in the chat; don't
			// fall into the transport-recovery path below.
			let msg = `request failed (${resp.status})`;
			const body = await resp.text();
			if (body) {
				try {
					msg = JSON.parse(body).error || body;
				} catch {
					msg = body;
				}
			}
			onError?.(new Error(msg));
			return;
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
		// error frame. The turn keeps running + is persisted server-side, so the
		// caller can recover by refetching. Tagged so it can tell the two apart.
		e.isTransport = true;
		onError?.(e);
	}
}
