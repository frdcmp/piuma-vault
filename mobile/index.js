import "./src/utils/dayjsConfig";
import notifee, { EventType } from "@notifee/react-native";
import { registerRootComponent } from "expo";

import App from "./App";
import {
	NOTIFICATION_SNOOZE_MINUTES,
	scheduleSnoozeAlarm,
} from "./src/utils/alarm";

// Notifee requires a background event handler registered at the top level (it
// runs even when the app is killed). This is what lets the lock-screen
// Dismiss / Snooze buttons work WITHOUT opening the app:
//   • Dismiss → just clear the ringing notification (stops loopSound).
//   • Snooze  → clear it and re-arm a new alarm N minutes out.
// If the user instead taps the body / full-screen intent, the app launches and
// App.js reads getInitialNotification() to show the in-app alarm.
notifee.onBackgroundEvent(async ({ type, detail }) => {
	const { notification, pressAction } = detail;
	if (type !== EventType.ACTION_PRESS) return;

	if (pressAction?.id === "snooze") {
		await scheduleSnoozeAlarm({
			title: notification?.title,
			body: notification?.body,
			tag: notification?.data?.tag,
			minutes: NOTIFICATION_SNOOZE_MINUTES,
		});
	}
	if (notification?.id) await notifee.cancelNotification(notification.id);
});

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
