/**
 * Expo config plugin for the Notifee full-screen alarm.
 *
 * Notifee's full-screen-intent notifications (the "real alarm clock" behaviour:
 * wake the screen and launch the app over the lock screen even when
 * backgrounded/killed) need three things in the Android manifest that neither
 * expo-notifications nor Notifee add automatically:
 *
 *   1. USE_FULL_SCREEN_INTENT  — permission to launch a full-screen activity.
 *   2. SCHEDULE_EXACT_ALARM    — permission for exact AlarmManager triggers
 *                                (used by Notifee TimestampTriggers).
 *   3. MainActivity flags `showWhenLocked` + `turnScreenOn` so the launched
 *      activity actually appears over the lock screen and wakes the display.
 *
 * Without this plugin a fresh `expo prebuild` / EAS build would drop all three.
 */
const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

const PERMISSIONS = [
	"android.permission.USE_FULL_SCREEN_INTENT",
	"android.permission.SCHEDULE_EXACT_ALARM",
];

function addPermissions(androidManifest) {
	const manifest = androidManifest.manifest;
	manifest["uses-permission"] = manifest["uses-permission"] || [];
	for (const name of PERMISSIONS) {
		const exists = manifest["uses-permission"].some(
			(p) => p.$?.["android:name"] === name,
		);
		if (!exists) {
			manifest["uses-permission"].push({ $: { "android:name": name } });
		}
	}
	return androidManifest;
}

function setMainActivityFlags(androidManifest) {
	const activity = AndroidConfig.Manifest.getMainActivityOrThrow(androidManifest);
	activity.$["android:showWhenLocked"] = "true";
	activity.$["android:turnScreenOn"] = "true";
	return androidManifest;
}

module.exports = function withAndroidAlarm(config) {
	return withAndroidManifest(config, (cfg) => {
		cfg.modResults = addPermissions(cfg.modResults);
		cfg.modResults = setMainActivityFlags(cfg.modResults);
		return cfg;
	});
};
