import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform, View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import {
	initialWindowMetrics,
	SafeAreaProvider,
} from "react-native-safe-area-context";
import { registerExpoToken } from "./src/api/notificationsApi";
import AlarmModal from "./src/components/AlarmModal";
import SystemBars from "./src/components/SystemBars";
import AppNavigator from "./src/navigation/AppNavigator";
import { useAlarmStore } from "./src/stores/alarmStore";
import { useAuthStore } from "./src/stores/authStore";
import { registerForPushNotifications } from "./src/utils/notifications";
import { asyncStoragePersister, queryClient } from "./src/utils/queryClient";
import { colors } from "./src/utils/theme";

// Turn a delivered notification into an in-app alarm payload.
function alarmFromNotification(notification) {
	const c = notification.request.content;
	return {
		tag: c.data?.tag || notification.request.identifier,
		title: c.title || "Reminder",
		body: c.body || "",
	};
}

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

	// Escalate delivered alerts to the loud in-app alarm: when one fires while
	// the app is foregrounded (received), or when the user taps one that fired
	// in the background (response).
	const present = useAlarmStore((s) => s.present);
	useEffect(() => {
		const received = Notifications.addNotificationReceivedListener((n) =>
			present(alarmFromNotification(n)),
		);
		const response = Notifications.addNotificationResponseReceivedListener((r) =>
			present(alarmFromNotification(r.notification)),
		);
		return () => {
			received.remove();
			response.remove();
		};
	}, [present]);

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
					<AlarmModal />
				</KeyboardProvider>
			</SafeAreaProvider>
		</PersistQueryClientProvider>
	);
}
