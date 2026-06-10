import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { WIDGET_CACHE_KEY, WIDGET_HORIZON_DAYS } from "./constants";

// Widget refreshes run in a HEADLESS context (OS-triggered background task /
// widget update), where the React tree — and therefore the hydrated zustand
// auth store and the axios interceptors — does not exist. So we read the tokens
// straight from SecureStore (the same keys authStore persists) and do the
// fetch + single 401-refresh by hand.
const BASE_URL =
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1";

const ACCESS_KEY = "token";
const REFRESH_KEY = "refresh_token";

async function readToken(key) {
	try {
		return await SecureStore.getItemAsync(key);
	} catch {
		return null;
	}
}

async function refreshAccessToken() {
	const refreshToken = await readToken(REFRESH_KEY);
	if (!refreshToken) return null;
	try {
		const res = await fetch(`${BASE_URL}/auth/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh_token: refreshToken }),
		});
		if (!res.ok) return null;
		const data = await res.json();
		if (!data?.access_token) return null;
		// Persist so the app and any later widget refresh see the rotated token.
		try {
			await SecureStore.setItemAsync(ACCESS_KEY, data.access_token);
		} catch {
			/* best-effort */
		}
		return data.access_token;
	} catch {
		return null;
	}
}

function get(token, days) {
	return fetch(`${BASE_URL}/widgets/summary?days=${days}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
}

// Read the last cached summary (may be null on a fresh install / logged out).
export async function loadCachedSummary() {
	try {
		const raw = await AsyncStorage.getItem(WIDGET_CACHE_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

// Fetch the widget summary, refreshing the access token once on 401. Caches the
// result and falls back to the cached copy on any failure, so the widget keeps
// showing the last known state rather than going blank.
export async function fetchWidgetSummary({ days = WIDGET_HORIZON_DAYS } = {}) {
	let token = await readToken(ACCESS_KEY);
	if (!token) return loadCachedSummary();

	try {
		let res = await get(token, days);
		if (res.status === 401) {
			token = await refreshAccessToken();
			if (!token) return loadCachedSummary();
			res = await get(token, days);
		}
		if (!res.ok) return loadCachedSummary();
		const data = await res.json();
		try {
			await AsyncStorage.setItem(WIDGET_CACHE_KEY, JSON.stringify(data));
		} catch {
			/* best-effort cache write */
		}
		return data;
	} catch {
		return loadCachedSummary();
	}
}
