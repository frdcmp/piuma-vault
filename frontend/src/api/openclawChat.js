const BASE_PATH = `${import.meta.env.BASE_URL}api/v1`;
const SESSION_KEY_STORAGE = "openclaw_session_key";

export const getSessionKey = () => {
	let key = localStorage.getItem(SESSION_KEY_STORAGE);
	if (!key) {
		key = crypto.randomUUID();
		localStorage.setItem(SESSION_KEY_STORAGE, key);
	}
	return key;
};

// Start a fresh conversation: mint a new session key so the next turns land on
// a new gateway session. The old conversation stays in OpenClaw, just orphaned.
export const rotateSessionKey = () => {
	const key = crypto.randomUUID();
	localStorage.setItem(SESSION_KEY_STORAGE, key);
	return key;
};

const buildRequest = ({ messages, model, signal }) => {
	const token = localStorage.getItem("token");
	return fetch(`${BASE_PATH}/llm/openclaw/chat`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-openclaw-session-key": getSessionKey(),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(model ? { messages, model } : { messages }),
		signal,
	});
};

let refreshPromise = null;

async function refreshAccessToken() {
	if (refreshPromise) return refreshPromise;
	const refreshToken = localStorage.getItem("refreshToken");
	if (!refreshToken) throw new Error("No refresh token");

	refreshPromise = fetch(`${BASE_PATH}/auth/refresh`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refresh_token: refreshToken }),
	})
		.then(async (resp) => {
			if (!resp.ok) throw new Error(`refresh failed ${resp.status}`);
			const data = await resp.json();
			localStorage.setItem("token", data.access_token);
			localStorage.setItem("refreshToken", data.refresh_token);
			return data.access_token;
		})
		.finally(() => {
			refreshPromise = null;
		});

	return refreshPromise;
}

// Streams OpenClaw chat completions via the rust proxy. Calls onToken(delta)
// for each visible content chunk and onTool(evt) for each tool-activity chunk
// (the gateway's namespaced `delta.openclaw` stream with `stream: "tool"`, see
// the "OpenClaw Gateway Stream" note — `evt` carries phase/name/toolCallId/args/
// isError). Resolves when the stream closes or [DONE] arrives. On 401, refreshes
// the access token once and retries.
export async function streamChat({
	messages,
	model,
	signal,
	onToken,
	onTool,
	onError,
}) {
	try {
		let resp = await buildRequest({ messages, model, signal });

		if (resp.status === 401 && localStorage.getItem("refreshToken")) {
			try {
				await refreshAccessToken();
				resp = await buildRequest({ messages, model, signal });
			} catch (refreshErr) {
				localStorage.removeItem("token");
				localStorage.removeItem("refreshToken");
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
				const line = event.split("\n").find((l) => l.startsWith("data: "));
				if (!line) continue;
				const data = line.slice(6).trim();
				if (data === "[DONE]") return;
				try {
					const json = JSON.parse(data);
					const delta = json.choices?.[0]?.delta;
					// Namespaced extra streams the gateway forwards alongside content.
					// We surface `tool` activity (which plugin is running + its args);
					// other streams (command_output/item/patch/…) are ignored for now.
					const oc = delta?.openclaw;
					if (oc?.stream === "tool") onTool?.(oc);
					if (delta?.content) onToken?.(delta.content);
				} catch {
					// keep-alives / non-JSON frames — ignore
				}
			}
		}
	} catch (e) {
		if (e?.name === "AbortError") return;
		onError?.(e);
	}
}

const buildHistoryRequest = (signal) => {
	const token = localStorage.getItem("token");
	return fetch(`${BASE_PATH}/llm/openclaw/history?limit=200`, {
		method: "GET",
		headers: {
			"x-openclaw-session-key": getSessionKey(),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		signal,
	});
};

// Loads this device's conversation FROM the OpenClaw gateway (the single source
// of truth — nothing is persisted locally). Returns `{role, content}[]` for the
// current session key. On 401, refreshes the access token once and retries.
export async function fetchOpenclawHistory({ signal } = {}) {
	let resp = await buildHistoryRequest(signal);
	if (resp.status === 401 && localStorage.getItem("refreshToken")) {
		try {
			await refreshAccessToken();
			resp = await buildHistoryRequest(signal);
		} catch (refreshErr) {
			localStorage.removeItem("token");
			localStorage.removeItem("refreshToken");
			throw refreshErr;
		}
	}
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`HTTP ${resp.status}: ${text || "history request failed"}`);
	}
	const data = await resp.json();
	return Array.isArray(data?.messages) ? data.messages : [];
}
