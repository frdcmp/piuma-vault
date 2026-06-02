import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform, View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import {
	initialWindowMetrics,
	SafeAreaProvider,
} from "react-native-safe-area-context";
import { registerExpoToken } from "./src/api/notificationsApi";
import SystemBars from "./src/components/SystemBars";
import AppNavigator from "./src/navigation/AppNavigator";
import { useAuthStore } from "./src/stores/authStore";
import { registerForPushNotifications } from "./src/utils/notifications";
import { asyncStoragePersister, queryClient } from "./src/utils/queryClient";
import { colors } from "./src/utils/theme";

export default function App() {
	// On web, RN's root only fills part of the viewport, so any uncovered
	// strip of <html>/<body> shows its default bg through. Paint them directly
	// so the dark vault bg goes edge-to-edge.
	useEffect(() => {
		if (Platform.OS !== "web") return;
		const html = document.documentElement;
		const body = document.body;
		html.style.backgroundColor = colors.bg;
		body.style.backgroundColor = colors.bg;
		html.style.margin = "0";
		body.style.margin = "0";
		html.style.height = "100%";
		body.style.height = "100%";
	}, []);

	// Once authenticated, register this device for remote push and report the
	// Expo token to the backend (best-effort; no-op on web / simulator / denial).
	const token = useAuthStore((state) => state.token);
	useEffect(() => {
		if (!token) return;
		let cancelled = false;
		(async () => {
			const pushToken = await registerForPushNotifications();
			if (!cancelled && pushToken) {
				try {
					await registerExpoToken(pushToken);
				} catch (_e) {
					/* best-effort */
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [token]);

	return (
		<PersistQueryClientProvider
			client={queryClient}
			persistOptions={{ persister: asyncStoragePersister }}
		>
			<SafeAreaProvider initialMetrics={initialWindowMetrics}>
				<KeyboardProvider statusBarTranslucent>
					<View style={{ flex: 1, backgroundColor: colors.bg }}>
						<AppNavigator />
					</View>
					<SystemBars />
					<StatusBar style="light" />
				</KeyboardProvider>
			</SafeAreaProvider>
		</PersistQueryClientProvider>
	);
}
