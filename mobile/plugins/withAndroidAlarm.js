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
	// The alarm rings via a Notifee foreground service so `loopSound` actually
	// loops (otherwise the channel sound plays once + stops). Android 14+ requires
	// the FGS type's permission.
	"android.permission.FOREGROUND_SERVICE",
	"android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
];

// Android 14+ requires the runtime FGS type to match the manifest. Declare
// `mediaPlayback` on Notifee's foreground service (override its default via
// tools:replace) so `startForeground(..., MEDIA_PLAYBACK)` doesn't throw.
const NOTIFEE_FGS = "app.notifee.core.ForegroundService";

function setForegroundServiceType(androidManifest) {
	const manifest = androidManifest.manifest;
	manifest.$ = manifest.$ || {};
	manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
	const app = manifest.application?.[0];
	if (!app) return androidManifest;
	app.service = app.service || [];
	let svc = app.service.find((s) => s.$?.["android:name"] === NOTIFEE_FGS);
	if (!svc) {
		svc = { $: { "android:name": NOTIFEE_FGS } };
		app.service.push(svc);
	}
	svc.$["android:foregroundServiceType"] = "mediaPlayback";
	svc.$["tools:replace"] = "android:foregroundServiceType";
	return androidManifest;
}

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
	const activity =
		AndroidConfig.Manifest.getMainActivityOrThrow(androidManifest);
	activity.$["android:showWhenLocked"] = "true";
	activity.$["android:turnScreenOn"] = "true";
	return androidManifest;
}

module.exports = function withAndroidAlarm(config) {
	return withAndroidManifest(config, (cfg) => {
		cfg.modResults = addPermissions(cfg.modResults);
		cfg.modResults = setMainActivityFlags(cfg.modResults);
		cfg.modResults = setForegroundServiceType(cfg.modResults);
		return cfg;
	});
};
