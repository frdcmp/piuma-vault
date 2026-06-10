// Shared identifiers for the Android home-screen widgets. The `name` values
// MUST match the `widgets[].name` entries in app.json's
// react-native-android-widget plugin config — that's how the native provider
// maps a placed widget back to the JS that renders it.
export const WIDGET_TASKS = "Tasks";
export const WIDGET_CALENDAR = "Calendar";

// AsyncStorage key for the last good /widgets/summary payload, used as an
// offline/first-paint fallback so a widget is never blank while a fetch is in
// flight or the device is offline.
export const WIDGET_CACHE_KEY = "widget:summary";

// expo-task-manager task name for the periodic background refresh.
export const WIDGET_BG_TASK = "vault-widget-refresh";

// How many days ahead the widgets show (matches the backend `days` param).
export const WIDGET_HORIZON_DAYS = 7;

// Deep-link targets (scheme `piumavault`, see app.json + AppNavigator linking).
export const DEEP_LINK_TASKS = "piumavault://tasks";
export const DEEP_LINK_CALENDAR = "piumavault://calendar";
