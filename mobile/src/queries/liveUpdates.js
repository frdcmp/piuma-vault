import { useEffect } from "react";
import EventSource from "react-native-sse";
import { refreshAccessToken } from "../api/axiosInstance";
import { useAuthStore } from "../stores/authStore";

const BASE_URL =
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1";

// Generic SSE live-update subscription, used by tasks and calendar so a change
// made on another device (web, another phone, an API-key client) shows up here
// without a manual refresh. Generalizes the notes implementation in
// notesQuery.js:
//  - `react-native-sse` (RN has no built-in EventSource).
//  - JWT in `Authorization: Bearer` (kept out of URLs/access logs); pulled from
//    the zustand auth store, refreshed via the shared single-flight refresh.
//  - On any event it invalidates `queryKey`; on a reconnect after a gap it does
//    the same so events missed while disconnected aren't lost.
//
// `queryKey` is the broad family key (e.g. ["tasks"]) — every event invalidates
// it, matching how the mutation hooks already invalidate the whole family.
export function useResourceLiveUpdates({ path, event, queryClient, queryKey }) {
	useEffect(() => {
		let es = null;
		let reconnectTimer = null;
		let attempts = 0;
		let cancelled = false;

		const invalidate = () => queryClient.invalidateQueries({ queryKey });

		const close = () => {
			if (!es) return;
			try {
				es.removeAllEventListeners();
			} catch {
				/* ignore */
			}
			try {
				es.close();
			} catch {
				/* ignore */
			}
			es = null;
		};

		const connect = () => {
			if (cancelled) return;

			const token = useAuthStore.getState().token;
			if (!token) return; // logged out

			es = new EventSource(`${BASE_URL}${path}`, {
				headers: { Authorization: `Bearer ${token}` },
				// react-native-sse has its own retry — disable it so our manual
				// loop is the single source of reconnect logic.
				pollingInterval: 0,
			});

			es.addEventListener(event, (evt) => {
				// We don't act on the {action, id} payload here — the lists are
				// keyed by filter/range, so any change just refetches the family.
				if (evt?.data === undefined) return;
				invalidate();
			});

			es.addEventListener("open", () => {
				if (attempts > 0) invalidate(); // backfill events missed during the gap
				attempts = 0;
			});

			const onFailure = async () => {
				if (cancelled) return;
				close();
				attempts += 1;

				// First failure on an established session → token most likely
				// expired. Refresh once before reconnecting.
				if (attempts === 1) {
					try {
						await refreshAccessToken();
					} catch {
						/* fall through — backoff will retry */
					}
					if (cancelled) return;
				}

				const delay = Math.min(30_000, 1000 * 2 ** (attempts - 1));
				reconnectTimer = setTimeout(connect, delay);
			};

			es.addEventListener("error", onFailure);
			es.addEventListener("close", onFailure);
		};

		connect();

		return () => {
			cancelled = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			close();
		};
	}, [queryClient, path, event, JSON.stringify(queryKey)]);
}
