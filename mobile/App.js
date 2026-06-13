import notifee from "@notifee/react-native";
import { focusManager } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
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
import ScreenLockGate from "./src/components/ScreenLockGate";
import SystemBars from "./src/components/SystemBars";
import ToastHost from "./src/components/Toast";
import AppNavigator from "./src/navigation/AppNavigator";
import { SpriteProvider } from "./src/sprites";
import { useAuthStore } from "./src/stores/authStore";
import { EventType, handleAlarmAction } from "./src/utils/alarm";
import { registerForPushNotifications } from "./src/utils/notifications";
import { subscribeForegroundAlarms } from "./src/utils/pushTask";
import { asyncStoragePersister, queryClient } from "./src/utils/queryClient";
import { colors } from "./src/utils/theme";
import { useWidgetSync } from "./src/widgets/useWidgetSync";

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
	// Keep the Android home-screen widgets in sync with in-app data changes,
	// foreground transitions, and the periodic background task.
	useWidgetSync();

	// Alarms ARE the OS notification (loud + persistent, with Complete/Snooze/
	// Dismiss buttons) — no in-app modal. index.js handles button presses while
	// the app is backgrounded/killed; this handles presses while it's foreground.
	useEffect(() => {
		// Action-button presses while the app is foreground.
		const unsub = notifee.onForegroundEvent(({ type, detail }) => {
			if (type === EventType.ACTION_PRESS) handleAlarmAction(detail);
		});
		// Server data pushes received while foreground → display the rich alarm
		// (the background task covers the app-closed case).
		const received = subscribeForegroundAlarms();
		return () => {
			unsub();
			received.remove();
		};
	}, []);

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
							<ToastHost />
						</KeyboardProvider>
					</SafeAreaProvider>
				</SpriteProvider>
			</PersistQueryClientProvider>
		</GestureHandlerRootView>
	);
}
