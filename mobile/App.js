import notifee from "@notifee/react-native";
import { focusManager } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import {
	initialWindowMetrics,
	SafeAreaProvider,
} from "react-native-safe-area-context";
import { registerExpoToken } from "./src/api/notificationsApi";
import AlarmModal from "./src/components/AlarmModal";
import ScreenLockGate from "./src/components/ScreenLockGate";
import SystemBars from "./src/components/SystemBars";
import ToastHost from "./src/components/Toast";
import AppNavigator from "./src/navigation/AppNavigator";
import { SpriteProvider } from "./src/sprites";
import { useAlarmStore } from "./src/stores/alarmStore";
import { useAuthStore } from "./src/stores/authStore";
import { alarmFromNotifee, EventType } from "./src/utils/alarm";
import { registerForPushNotifications } from "./src/utils/notifications";
import { asyncStoragePersister, queryClient } from "./src/utils/queryClient";
import { colors } from "./src/utils/theme";
import { useWidgetSync } from "./src/widgets/useWidgetSync";

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

	// Wire TanStack Query's focusManager to AppState. RN has no window-focus
	// event, so `refetchOnWindowFocus` is dead by default — this makes queries
	// refetch when the app returns to the foreground (e.g. after adding a task
	// from Telegram while backgrounded). Respects each query's staleTime.
	useEffect(() => {
		const sub = AppState.addEventListener("change", (status) => {
			if (Platform.OS !== "web") focusManager.setFocused(status === "active");
		});
		return () => sub.remove();
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

	// Escalate delivered alerts to the loud in-app alarm. Two delivery systems
	// feed the same store (de-duped by tag):
	//   • expo-notifications — REMOTE push (foreground receive / tap-to-open).
	//   • Notifee — LOCAL full-screen alarms. Its full-screen intent wakes the
	//     screen and launches the app over the lock screen; on launch we read
	//     getInitialNotification(), and while foregrounded onForegroundEvent
	//     fires DELIVERED. Either way we present the in-app modal, which owns the
	//     looping sound — so we don't double up with Notifee's loopSound.
	// Keep the Android home-screen widgets in sync with in-app data changes,
	// foreground transitions, and the periodic background task.
	useWidgetSync();

	const present = useAlarmStore((s) => s.present);
	useEffect(() => {
		const received = Notifications.addNotificationReceivedListener((n) =>
			present(alarmFromNotification(n)),
		);
		const response = Notifications.addNotificationResponseReceivedListener(
			(r) => present(alarmFromNotification(r.notification)),
		);

		const unsubNotifee = notifee.onForegroundEvent(({ type, detail }) => {
			if (type === EventType.DELIVERED || type === EventType.PRESS) {
				if (detail.notification) present(alarmFromNotifee(detail.notification));
			}
		});

		// App was cold-launched by tapping / a full-screen alarm intent.
		notifee.getInitialNotification().then((initial) => {
			if (initial?.notification)
				present(alarmFromNotifee(initial.notification));
		});

		return () => {
			received.remove();
			response.remove();
			unsubNotifee();
		};
	}, [present]);

	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<PersistQueryClientProvider
				client={queryClient}
				persistOptions={{ persister: asyncStoragePersister }}
			>
				<SpriteProvider>
					<SafeAreaProvider initialMetrics={initialWindowMetrics}>
						<KeyboardProvider statusBarTranslucent>
							<View style={{ flex: 1, backgroundColor: colors.bg }}>
								<ScreenLockGate>
									<AppNavigator />
								</ScreenLockGate>
							</View>
							<SystemBars />
							<StatusBar style="light" />
							<AlarmModal />
							<ToastHost />
						</KeyboardProvider>
					</SafeAreaProvider>
				</SpriteProvider>
			</PersistQueryClientProvider>
		</GestureHandlerRootView>
	);
}
