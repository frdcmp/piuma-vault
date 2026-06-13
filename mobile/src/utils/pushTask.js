import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { displayAlarmNow } from "./alarm";

// Background notification task: the notification-worker sends DATA-ONLY pushes
// (type: "alarm"); when one arrives we re-display it as a rich, loud Notifee
// alarm with Complete/Snooze/Dismiss buttons — handled by the same
// handleAlarmAction path as locally-scheduled alarms. This is what gives
// SERVER-pushed reminders the TickTick-style action buttons even when the app is
// closed. Defined at module load (imported from index.js) so it exists before
// the OS invokes it headlessly.
export const BACKGROUND_NOTIFICATION_TASK = "vault-bg-notification";

// The payload shape differs across platforms / expo-notifications versions, so
// dig for the object that looks like our alarm push.
function pickAlarmData(payload) {
	const candidates = [
		payload?.data,
		payload?.notification?.data,
		payload?.notification?.request?.content?.data,
		payload?.notification?.request?.trigger?.remoteMessage?.data,
	];
	for (const c of candidates) {
		if (c && (c.type === "alarm" || c.source_type || c.tag)) return c;
	}
	// FCM sometimes nests the Expo message JSON as a string under `body`.
	const raw = payload?.notification?.data?.body ?? payload?.data?.body;
	if (typeof raw === "string") {
		try {
			const j = JSON.parse(raw);
			return j?.data || j;
		} catch {
			/* not JSON */
		}
	}
	return null;
}

// Turn an extracted alarm-push data object into a displayed alarm.
export async function displayFromPushData(data) {
	if (!data || data.type !== "alarm") return;
	await displayAlarmNow({
		title: data.title,
		body: data.body,
		tag: data.tag,
		source: {
			source_type: data.source_type,
			source_id: data.source_id,
			occurrence_date: data.occurrence_date,
		},
	});
}

TaskManager.defineTask(
	BACKGROUND_NOTIFICATION_TASK,
	async ({ data, error }) => {
		if (error) return;
		try {
			await displayFromPushData(pickAlarmData(data));
		} catch (_e) {
			/* best-effort */
		}
	},
);

// Register the task so incoming background push data is routed to it. Idempotent.
export async function registerBackgroundNotificationTask() {
	try {
		await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
	} catch (_e) {
		/* best-effort — older runtimes / unsupported platforms */
	}
}

// Foreground counterpart: while the app is open the background task doesn't run,
// so listen for received pushes and display the alarm the same way. Returns the
// subscription so the caller can remove it.
export function subscribeForegroundAlarms() {
	return Notifications.addNotificationReceivedListener((n) => {
		displayFromPushData(pickAlarmData({ notification: n }));
	});
}
