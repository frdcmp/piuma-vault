import dayjs from "dayjs";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import {
	cancelAllAlarms,
	ensureAlarmChannel,
	requestAlarmPermissions,
	scheduleAlarm,
} from "./alarm";
import { expandRecurrence } from "./recurrence";

// Foreground display behavior (SDK 53+ fields: shouldShowBanner / shouldShowList
// replace the deprecated shouldShowAlert).
Notifications.setNotificationHandler({
	handleNotification: async () => ({
		shouldPlaySound: true,
		shouldSetBadge: false,
		shouldShowBanner: true,
		shouldShowList: true,
	}),
});

// Local-scheduling horizon. The OS caps pending notifications (iOS ~64), so we
// schedule the nearest window and lean on server-side remote push beyond it.
const HORIZON_DAYS = 30;
const MAX_LOCAL = 60;

export async function configureAndroidChannel() {
	if (Platform.OS !== "android") return;
	await Notifications.setNotificationChannelAsync("default", {
		name: "Reminders",
		importance: Notifications.AndroidImportance.HIGH,
		vibrationPattern: [0, 250, 250, 250],
	});
}

// Ask permission and return the Expo push token, or null if unavailable/denied.
export async function registerForPushNotifications() {
	if (!Device.isDevice) return null;

	const existing = await Notifications.getPermissionsAsync();
	let status = existing.status;
	if (status !== "granted") {
		const req = await Notifications.requestPermissionsAsync();
		status = req.status;
	}
	if (status !== "granted") return null;

	await configureAndroidChannel();
	// Alarm channel + exact-alarm permission for the local full-screen alarms.
	await requestAlarmPermissions();

	const projectId =
		Constants?.expoConfig?.extra?.eas?.projectId ??
		Constants?.easConfig?.projectId;
	try {
		const token = await Notifications.getExpoPushTokenAsync({ projectId });
		console.log("[notifications] expo push token:", token.data);
		return token.data;
	} catch (e) {
		// Most common cause on Android: missing/invalid FCM config
		// (google-services.json + FCM V1 key uploaded to Expo).
		console.warn("[notifications] getExpoPushTokenAsync failed:", e?.message || e);
		return null;
	}
}

function offsetLabel(mins) {
	if (mins <= 0) return "now";
	if (mins % 1440 === 0) return `in ${mins / 1440}d`;
	if (mins % 60 === 0) return `in ${mins / 60}h`;
	return `in ${mins}m`;
}

// Collect concrete (title, fireDate) reminders from the loaded agenda data.
function buildReminders({ events = [], tasks = [], recurring = [] }) {
	const now = dayjs();
	const horizon = now.add(HORIZON_DAYS, "day");
	const out = [];

	// `tag` = `{source_type}:{source_id}`, matching the backend's remote-push tag
	// so a local + remote delivery of the same alert de-dupes to one alarm.
	const addAlerts = (anchorISO, title, alerts, tag) => {
		if (!anchorISO || !Array.isArray(alerts)) return;
		const anchor = dayjs(anchorISO);
		for (const a of alerts) {
			const fire = anchor.subtract(Math.max(0, a.offset_minutes || 0), "minute");
			if (fire.isAfter(now) && fire.isBefore(horizon)) {
				out.push({
					title,
					body: offsetLabel(a.offset_minutes),
					date: fire.toDate(),
					tag,
				});
			}
		}
	};

	// One-off (non-recurring) events.
	for (const ev of events) {
		if (ev.rrule) continue; // recurring events rely on remote push
		addAlerts(ev.starts_at, ev.title, ev.alerts, `event:${ev.id}`);
	}

	// One-off tasks with a due date.
	for (const t of tasks) {
		if (t.done || t.recurrence_id) continue;
		addAlerts(t.due_at, t.title, t.alerts, `task:${t.id}`);
	}

	// Recurring task templates → expand occurrences within the horizon.
	for (const tpl of recurring) {
		if (!tpl.active || !Array.isArray(tpl.alerts) || !tpl.alerts.length) continue;
		const occurrences = expandRecurrence({
			rrule: tpl.rrule,
			dtstart: tpl.dtstart,
			rangeStart: now,
			rangeEnd: horizon,
			until: tpl.until,
		});
		for (const occ of occurrences) {
			const occDate = dayjs(occ);
			for (const a of tpl.alerts) {
				const fire = occDate.subtract(Math.max(0, a.offset_minutes || 0), "minute");
				if (fire.isAfter(now) && fire.isBefore(horizon)) {
					out.push({
						title: tpl.title,
						body: offsetLabel(a.offset_minutes),
						date: fire.toDate(),
						tag: `recurring:${tpl.id}`,
					});
				}
			}
		}
	}

	return out.sort((x, y) => x.date - y.date).slice(0, MAX_LOCAL);
}

// Reschedule ALL local alarms from the current source-of-truth data.
// Idempotent: cancels everything then re-schedules the nearest window as
// Notifee full-screen-intent trigger notifications (wake the screen / launch
// the app over the lock screen even when backgrounded). Each id is stable per
// (tag, fire-time) so a re-sync overwrites instead of duplicating.
export async function syncLocalAlerts(data) {
	try {
		await ensureAlarmChannel();
		const reminders = buildReminders(data);
		await cancelAllAlarms();
		for (const r of reminders) {
			await scheduleAlarm({
				id: `${r.tag}:${r.date.getTime()}`,
				title: r.title,
				body: r.body,
				tag: r.tag,
				date: r.date,
			});
		}
	} catch (_e) {
		// Local scheduling is best-effort; remote push is the reliable path.
	}
}
