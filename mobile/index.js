// Must be the very first import: react-native-gesture-handler requires loading
// at the top of the entry file so its native side initialises before anything
// renders (needed by the draggable task list).
import "react-native-gesture-handler";
import "./src/utils/dayjsConfig";
import notifee, { EventType } from "@notifee/react-native";
import { registerRootComponent } from "expo";
import { Platform } from "react-native";

import App from "./App";
import { handleAlarmAction } from "./src/utils/alarm";
// Defines the background notification task at module load so the OS can invoke
// it headlessly when a data push arrives (server reminders → rich alarm).
import "./src/utils/pushTask";

// Notifee requires a background event handler registered at the top level (it
// runs even when the app is killed). This is what makes the notification's
// Complete / Snooze / Dismiss buttons work WITHOUT opening the app:
//   • Complete → mark the task/occurrence done via a background API call.
//   • Snooze   → clear it and re-arm a new alarm N minutes out.
//   • Dismiss  → just clear the ringing notification (stops loopSound).
// Tapping the body opens the app normally.
notifee.onBackgroundEvent(async ({ type, detail }) => {
	if (type !== EventType.ACTION_PRESS) return;
	await handleAlarmAction(detail);
});

// Android home-screen widgets. The task handler must be registered at the entry
// (it runs headlessly when the OS updates a widget, before App mounts), and
// importing backgroundTask defines the periodic refresh task. Guarded to Android
// + require()'d so the native-only module never loads in the web/iOS bundles.
if (Platform.OS === "android") {
	const { registerWidgetTaskHandler } = require("react-native-android-widget");
	const { widgetTaskHandler } = require("./src/widgets/widgetTaskHandler");
	registerWidgetTaskHandler(widgetTaskHandler);
	require("./src/widgets/backgroundTask");
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
