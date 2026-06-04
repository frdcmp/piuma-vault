import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

// Generic SSE live-update subscription, used by tasks and calendar so a change
// made elsewhere (another tab, the mobile app, an x-api-key integration) shows
// up without a manual refresh. Generalizes the notes implementation in
// notesQuery.js:
//  - Native EventSource with the JWT in `?token=` (EventSource can't set headers).
//  - Native EventSource auto-reconnects on transient TCP drops but gives up on
//    HTTP errors (most often a 401 once the JWT expires). This hook layers manual
//    reconnect on top: on a permanent close it refreshes the token, then reopens
//    with exponential backoff, invalidating on each reconnect to catch up on
//    events missed during the gap.
//
// `queryKey` is the broad family key (e.g. ["tasks"]) — every event invalidates
// it, matching how the mutation hooks already invalidate the whole family.
export function useResourceLiveUpdates({ path, event, queryKey }) {
	const qc = useQueryClient();

	useEffect(() => {
		let es = null;
		let reconnectTimer = null;
		let attempts = 0;
		let cancelled = false;

		const base = `${import.meta.env.BASE_URL}api/v1`;
		const invalidate = () => qc.invalidateQueries({ queryKey });

		const tryRefreshToken = async () => {
			const refreshToken = localStorage.getItem("refreshToken");
			if (!refreshToken) return false;
			try {
				const res = await fetch(`${base}/auth/refresh`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ refresh_token: refreshToken }),
				});
				if (!res.ok) return false;
				const data = await res.json();
				if (data?.access_token) {
					localStorage.setItem("token", data.access_token);
				}
				if (data?.refresh_token) {
					localStorage.setItem("refreshToken", data.refresh_token);
				}
				return !!data?.access_token;
			} catch {
				return false;
			}
		};

		const handleEvent = (evt) => {
			// We don't act on the {action, id} payload — the lists are keyed by
			// filter/range, so any change just refetches the family.
			if (evt?.data === undefined) return;
			invalidate();
		};

		const connect = () => {
			if (cancelled) return;

			const token = localStorage.getItem("token");
			if (!token) return; // logged out — nothing to listen to

			const url = `${base}${path}?token=${encodeURIComponent(token)}`;
			es = new EventSource(url);

			es.addEventListener(event, handleEvent);

			es.addEventListener("open", () => {
				if (attempts > 0) invalidate(); // catch up on events missed in the gap
				attempts = 0;
			});

			es.onerror = async () => {
				// Native EventSource handles transient TCP drops itself — only step
				// in once it has permanently closed (HTTP error, most often 401).
				if (cancelled || !es) return;
				if (es.readyState !== EventSource.CLOSED) return;

				es.close();
				es = null;
				attempts += 1;

				// First failure on an established session almost always means the
				// access token aged out — refresh before reconnecting.
				if (attempts === 1) {
					await tryRefreshToken();
					if (cancelled) return;
				}

				const delay = Math.min(30_000, 1000 * 2 ** (attempts - 1));
				reconnectTimer = setTimeout(connect, delay);
			};
		};

		connect();

		return () => {
			cancelled = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (es) es.close();
		};
		// `queryKey` is a module-level constant array (e.g. taskKeys.all), so its
		// reference is stable across renders — safe to depend on directly.
	}, [qc, path, event, queryKey]);
}
