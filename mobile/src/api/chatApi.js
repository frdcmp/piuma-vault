import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetch } from 'expo/fetch';
import { useAuthStore } from '../stores/authStore';
import { refreshAccessToken } from './axiosInstance';

const BASE_PATH =
	process.env.EXPO_PUBLIC_API_URL || 'https://vault.example.com/api/v1';
const SESSION_KEY_STORAGE = 'openclaw_session_key';

let sessionKeyCache = null;

const generateSessionKey = () => {
	const rand = () => Math.random().toString(36).slice(2, 10);
	return `${Date.now().toString(36)}-${rand()}-${rand()}`;
};

export const getSessionKey = async () => {
	if (sessionKeyCache) return sessionKeyCache;
	let key = await AsyncStorage.getItem(SESSION_KEY_STORAGE);
	if (!key) {
		key = generateSessionKey();
		await AsyncStorage.setItem(SESSION_KEY_STORAGE, key);
	}
	sessionKeyCache = key;
	return key;
};

// Start a fresh conversation: mint a new session key so the next turns land on
// a new gateway session. The old conversation stays in OpenClaw, just orphaned.
export const rotateSessionKey = async () => {
	const key = generateSessionKey();
	sessionKeyCache = key;
	await AsyncStorage.setItem(SESSION_KEY_STORAGE, key);
	return key;
};

const buildRequest = async ({ messages, model, signal }) => {
	const token = useAuthStore.getState().token;
	const sessionKey = await getSessionKey();
	return fetch(`${BASE_PATH}/llm/openclaw/chat`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-openclaw-session-key': sessionKey,
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(model ? { messages, model } : { messages }),
		signal,
	});
};

// Streams OpenClaw chat completions via the rust proxy. Calls onToken(delta)
// for each visible content chunk and onTool(evt) for each tool-activity chunk
// (the gateway's namespaced `delta.openclaw` stream with `stream: "tool"` —
// `evt` carries phase/name/toolCallId/args/isError). Resolves when the stream
// closes or [DONE] arrives. On 401, refreshes the access token once (sharing
// the axios single-flight refreshPromise) and retries.
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

		if (resp.status === 401 && useAuthStore.getState().refreshToken) {
			try {
				await refreshAccessToken();
				resp = await buildRequest({ messages, model, signal });
			} catch (refreshErr) {
				await useAuthStore.getState().logout();
				throw refreshErr;
			}
		}

		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`HTTP ${resp.status}: ${text || 'request failed'}`);
		}

		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx;
			while ((idx = buffer.indexOf('\n\n')) >= 0) {
				const event = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const line = event.split('\n').find((l) => l.startsWith('data: '));
				if (!line) continue;
				const data = line.slice(6).trim();
				if (data === '[DONE]') return;
				try {
					const json = JSON.parse(data);
					const delta = json.choices?.[0]?.delta;
					// Namespaced extra streams forwarded alongside content. We surface
					// `tool` activity (which plugin is running + its args); other
					// streams (command_output/item/patch/…) are ignored for now.
					const oc = delta?.openclaw;
					if (oc?.stream === 'tool') onTool?.(oc);
					if (delta?.content) onToken?.(delta.content);
				} catch {
					// keep-alives / non-JSON frames — ignore
				}
			}
		}
	} catch (e) {
		if (e?.name === 'AbortError') return;
		onError?.(e);
	}
}

const buildHistoryRequest = async (signal) => {
	const token = useAuthStore.getState().token;
	const sessionKey = await getSessionKey();
	return fetch(`${BASE_PATH}/llm/openclaw/history?limit=200`, {
		method: 'GET',
		headers: {
			'x-openclaw-session-key': sessionKey,
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
	if (resp.status === 401 && useAuthStore.getState().refreshToken) {
		try {
			await refreshAccessToken();
			resp = await buildHistoryRequest(signal);
		} catch (refreshErr) {
			await useAuthStore.getState().logout();
			throw refreshErr;
		}
	}
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`HTTP ${resp.status}: ${text || 'history request failed'}`);
	}
	const data = await resp.json();
	return Array.isArray(data?.messages) ? data.messages : [];
}
