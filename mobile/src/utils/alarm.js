import notifee, {
	AlarmType,
	AndroidCategory,
	AndroidImportance,
	AndroidNotificationSetting,
	AndroidVisibility,
	AuthorizationStatus,
	EventType,
	TriggerType,
} from "@notifee/react-native";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// Backend base — mirrors api/axiosInstance. Used by the background "Complete"
// action, which can't go through axios/zustand (they aren't initialised when the
// OS wakes the app headlessly to handle a notification button).
const API_BASE =
	process.env.EXPO_PUBLIC_API_URL || "https://vault.example.com/api/v1";

// Minutes the notification "Snooze" button re-arms for (single tap).
export const NOTIFICATION_SNOOZE_MINUTES = 10;

// Dedicated high-importance channel for alarms. `loopSound` keeps the channel's
// sound ringing until the user interacts, and the full-screen intent (set per
// notification) wakes the screen / launches the app over the lock screen.
export const ALARM_CHANNEL_ID = "alarm";

let channelReady = false;
let alarmSettingsPrompted = false;

export async function ensureAlarmChannel() {
	if (Platform.OS !== "android" || channelReady) return;
	await notifee.createChannel({
		id: ALARM_CHANNEL_ID,
		name: "Alarms",
		importance: AndroidImportance.HIGH,
		visibility: AndroidVisibility.PUBLIC,
		vibration: true,
		// Notifee requires an even number of POSITIVE values: [vibrate, pause, …]
		// (no leading 0 like Android's native / expo-notifications convention).
		vibrationPattern: [500, 500, 500, 500],
		bypassDnd: true,
	});
	channelReady = true;
}

// Notification + exact-alarm permissions. Returns true if we can post alarms.
// The full-screen-intent permission is declared in the manifest (see
// plugins/withAndroidAlarm.js); on Android 14+ the OS grants it to apps that
// post genuine alarms/reminders and may otherwise downgrade to a heads-up.
export async function requestAlarmPermissions() {
	const settings = await notifee.requestPermission();
	const granted =
		settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
		settings.authorizationStatus === AuthorizationStatus.PROVISIONAL;

	if (Platform.OS === "android") {
		await ensureAlarmChannel();
		// Exact alarms (Android 12+): if the user hasn't allowed them, send them
		// to the system setting — but only once per app process, so we don't pop
		// the settings screen on every launch. Inexact triggers still fire, just
		// less precisely, if the user declines.
		const s = await notifee.getNotificationSettings();
		if (
			!alarmSettingsPrompted &&
			s.android?.alarm !== AndroidNotificationSetting.ENABLED
		) {
			alarmSettingsPrompted = true;
			try {
				await notifee.openAlarmPermissionSettings();
			} catch (_e) {
				/* best-effort — user can enable it later */
			}
		}
	}
	return granted;
}

// Build the Android alarm-notification payload (shared by scheduled + snoozed
// alarms). TickTick-style: a loud, persistent heads-up notification that rings
// (`loopSound`) and can't be swiped away (`ongoing`) until an action button is
// pressed — handled in the background/foreground event handlers so it works with
// the app closed. NO in-app modal. `source` ({ source_type, source_id,
// occurrence_date }) rides in `data` so "Complete" can mark the task done.
function alarmNotification({ id, title, body, tag, source = {} }) {
	const { source_type, source_id, occurrence_date } = source;
	// "Complete" only makes sense for tasks / recurring-task occurrences.
	const canComplete = source_type === "task" || source_type === "recurring";
	const actions = [];
	if (canComplete) {
		actions.push({ title: "Complete", pressAction: { id: "complete" } });
	}
	actions.push({
		title: `Snooze ${NOTIFICATION_SNOOZE_MINUTES}m`,
		pressAction: { id: "snooze" },
	});
	actions.push({ title: "Dismiss", pressAction: { id: "dismiss" } });

	return {
		id,
		title: title || "Reminder",
		body: body || "",
		data: {
			tag: tag || id,
			source_type: source_type || "",
			source_id: source_id || "",
			occurrence_date: occurrence_date || "",
		},
		android: {
			channelId: ALARM_CHANNEL_ID,
			category: AndroidCategory.ALARM,
			importance: AndroidImportance.HIGH,
			visibility: AndroidVisibility.PUBLIC,
			// Tap the body to open the app; action buttons handle complete/snooze/
			// dismiss without opening it.
			pressAction: { id: "default" },
			loopSound: true,
			ongoing: true,
			autoCancel: false,
			actions,
		},
	};
}

// Schedule one alarm to fire at `date`. `id` is stable per reminder so a
// reschedule overwrites rather than duplicates. Returns the created id.
export async function scheduleAlarm({ id, title, body, tag, date, source }) {
	await ensureAlarmChannel();
	await notifee.createTriggerNotification(
		alarmNotification({ id, title, body, tag, source }),
		{
			type: TriggerType.TIMESTAMP,
			timestamp: date.getTime(),
			// setAlarmClock(): Doze-exempt, fires exactly even with the app closed.
			alarmManager: { type: AlarmType.SET_ALARM_CLOCK },
		},
	);
	return id;
}

// Fire an alarm `minutes` from now (the Snooze button). Carries the source
// through so the re-armed alarm keeps its Complete button.
export async function scheduleSnoozeAlarm({
	title,
	body,
	tag,
	minutes,
	source,
}) {
	await ensureAlarmChannel();
	const id = `${tag || "snooze"}:snooze:${minutes}`;
	await notifee.createTriggerNotification(
		alarmNotification({ id, title, body, tag, source }),
		{
			type: TriggerType.TIMESTAMP,
			timestamp: Date.now() + minutes * 60 * 1000,
			// setAlarmClock(): Doze-exempt, fires exactly even with the app closed.
			alarmManager: { type: AlarmType.SET_ALARM_CLOCK },
		},
	);
	return id;
}

// Display an alarm RIGHT NOW (not scheduled) — used by the background push task
// when a data push arrives: the server-pushed reminder becomes the same rich,
// loud notification with Complete/Snooze/Dismiss as a locally-scheduled one. The
// id is derived from the tag so repeated deliveries of the same alert collapse
// (and overlap a local-scheduled one rather than double).
export async function displayAlarmNow({ title, body, tag, source }) {
	await ensureAlarmChannel();
	const id = tag || `alarm:${Date.now()}`;
	await notifee.displayNotification(
		alarmNotification({ id, title, body, tag, source }),
	);
	return id;
}

// Drop every pending alarm trigger — the reschedule path cancels then re-adds.
export async function cancelAllAlarms() {
	try {
		await notifee.cancelTriggerNotifications();
	} catch (_e) {
		/* best-effort */
	}
}

// Stop a currently-ringing alarm: cancels the displayed notification (which
// stops loopSound) so the in-app modal owns the audio from here.
export async function stopRingingNotification(notificationId) {
	try {
		if (notificationId)
			await notifee.cancelDisplayedNotification(notificationId);
		else await notifee.cancelDisplayedNotifications();
	} catch (_e) {
		/* best-effort */
	}
}

// Handle a notification action-button press (Complete / Snooze / Dismiss) from
// either the background (index.js) or foreground (App.js) Notifee event handler.
// Works with the app closed — no in-app modal involved.
export async function handleAlarmAction({ notification, pressAction }) {
	const id = pressAction?.id;
	const data = notification?.data || {};
	if (id === "snooze") {
		await scheduleSnoozeAlarm({
			title: notification?.title,
			body: notification?.body,
			tag: data.tag,
			minutes: NOTIFICATION_SNOOZE_MINUTES,
			source: {
				source_type: data.source_type,
				source_id: data.source_id,
				occurrence_date: data.occurrence_date,
			},
		});
	} else if (id === "complete") {
		await completeReminder(data);
	}
	// Snooze / Complete / Dismiss all clear the ringing notification.
	if (notification?.id) await notifee.cancelNotification(notification.id);
}

// Mark the task / recurring-occurrence behind an alarm done, straight from the
// notification button. Raw fetch + token from SecureStore because axios/zustand
// aren't initialised when the OS wakes the app headlessly. Best-effort.
async function completeReminder(data) {
	try {
		const sourceType = data?.source_type;
		const sourceId = data?.source_id;
		if (!sourceType || !sourceId) return;
		const token =
			Platform.OS === "web" ? null : await SecureStore.getItemAsync("token");
		const headers = {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		};
		let url;
		let body;
		if (sourceType === "task") {
			url = `${API_BASE}/admin/tasks/${sourceId}/toggle`;
		} else if (sourceType === "recurring" && data?.occurrence_date) {
			url = `${API_BASE}/admin/recurring-tasks/${sourceId}/occurrences/${data.occurrence_date}/complete`;
			body = JSON.stringify({ done: true });
		} else {
			return;
		}
		await fetch(url, { method: "PUT", headers, body });
	} catch (_e) {
		// Best-effort: the alarm is cleared regardless so it won't keep ringing.
	}
}

export { EventType };
