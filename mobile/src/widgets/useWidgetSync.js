import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { useAuthStore } from "../stores/authStore";
import { queryClient } from "../utils/queryClient";

// Keeps the Android home-screen widgets in sync with the app while it's alive,
// bridging the ~15-min background-refresh floor:
//   • registers the periodic background task once,
//   • refreshes widgets when the app is foregrounded,
//   • refreshes whenever the ["tasks"] / ["calendar"] query families change —
//     which already covers SSE live updates, mutations, and focus refetches.
//
// Android-only and a no-op elsewhere. The native-dependent modules are loaded
// via dynamic import so the web/iOS bundles never pull in android-only code.
export function useWidgetSync() {
	const token = useAuthStore((s) => s.token);

	useEffect(() => {
		if (Platform.OS !== "android" || !token) return;

		let cancelled = false;
		let timer = null;
		let refresh = null;

		const run = () => {
			if (cancelled || !refresh) return;
			refresh().catch(() => {});
		};
		const schedule = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(run, 1500); // coalesce bursts of cache changes
		};

		(async () => {
			const [{ refreshAllWidgets }, { registerWidgetBackgroundTask }] =
				await Promise.all([import("./refresh"), import("./backgroundTask")]);
			if (cancelled) return;
			refresh = refreshAllWidgets;
			registerWidgetBackgroundTask();
			schedule(); // initial paint with current data
		})();

		const unsub = queryClient.getQueryCache().subscribe((event) => {
			const key = event?.query?.queryKey?.[0];
			if (key === "tasks" || key === "calendar") schedule();
		});

		const appSub = AppState.addEventListener("change", (status) => {
			if (status === "active") schedule();
		});

		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
			unsub();
			appSub.remove();
		};
	}, [token]);
}
