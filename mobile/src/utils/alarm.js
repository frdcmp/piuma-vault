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
import { Platform } from "react-native";

// Minutes the lock-screen "Snooze" button re-arms for. The in-app modal still
// offers the full 5/10/15 choice; the notification button is a single tap.
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
		vibrationPattern: [0, 500, 500, 500],
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

// Build the Android payload shared by scheduled + snoozed alarms. The
// full-screen action launches MainActivity (flagged showWhenLocked /
// turnScreenOn) so the in-app AlarmModal can take over even from a locked
// screen; `loopSound` + `ongoing` keep it ringing until dismissed.
function alarmNotification({ id, title, body, tag }) {
	return {
		id,
		title: title || "Reminder",
		body: body || "",
		data: { tag: tag || id },
		android: {
			channelId: ALARM_CHANNEL_ID,
			category: AndroidCategory.ALARM,
			importance: AndroidImportance.HIGH,
			visibility: AndroidVisibility.PUBLIC,
			fullScreenAction: { id: "default" },
			pressAction: { id: "default" },
			loopSound: true,
			ongoing: true,
			autoCancel: false,
			// Lock-screen buttons so the alarm can be handled WITHOUT opening the
			// app. Resolved in the background event handler (index.js).
			actions: [
				{ title: "Dismiss", pressAction: { id: "dismiss" } },
				{
					title: `Snooze ${NOTIFICATION_SNOOZE_MINUTES}m`,
					pressAction: { id: "snooze" },
				},
			],
		},
	};
}

// Schedule one alarm to fire at `date`. `id` is stable per reminder so a
// reschedule overwrites rather than duplicates. Returns the created id.
export async function scheduleAlarm({ id, title, body, tag, date }) {
	await ensureAlarmChannel();
	await notifee.createTriggerNotification(alarmNotification({ id, title, body, tag }), {
		type: TriggerType.TIMESTAMP,
		timestamp: date.getTime(),
		// setAlarmClock(): Doze-exempt, fires exactly even with the app closed.
		alarmManager: { type: AlarmType.SET_ALARM_CLOCK },
	});
	return id;
}

// Fire an alarm `minutes` from now (used by the in-app Snooze).
export async function scheduleSnoozeAlarm({ title, body, tag, minutes }) {
	await ensureAlarmChannel();
	const id = `${tag || "snooze"}:snooze:${minutes}`;
	await notifee.createTriggerNotification(
		alarmNotification({ id, title, body, tag }),
		{
			type: TriggerType.TIMESTAMP,
			timestamp: Date.now() + minutes * 60 * 1000,
			// setAlarmClock(): Doze-exempt, fires exactly even with the app closed.
			alarmManager: { type: AlarmType.SET_ALARM_CLOCK },
		},
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
		if (notificationId) await notifee.cancelDisplayedNotification(notificationId);
		else await notifee.cancelDisplayedNotifications();
	} catch (_e) {
		/* best-effort */
	}
}

// Map a Notifee event's notification into the alarm-store payload shape.
export function alarmFromNotifee(notification) {
	return {
		tag: notification?.data?.tag || notification?.id,
		title: notification?.title || "Reminder",
		body: notification?.body || "",
		notificationId: notification?.id,
	};
}

export { EventType };
