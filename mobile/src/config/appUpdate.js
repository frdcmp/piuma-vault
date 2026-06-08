import * as Application from "expo-application";
import Constants from "expo-constants";

// Update manifest published by `mobile/build.sh -p apk` to the storage zone.
// The folder is token-protected, so the app reads it through our backend
// (GET /storage/app-update-manifest) rather than the CDN. Shape:
//   { version, buildTime, apkKey, apkFilename, notes }
export const MANIFEST_KEY = "expo/pv/apk/latest.json";

// The running app's version. In a standalone APK the authoritative value is the
// native versionName (set by EAS from app.json) — `Constants.expoConfig` can be
// null in release builds — so prefer expo-application and fall back to Constants.
export const CURRENT_VERSION =
	Application.nativeApplicationVersion ||
	Constants.expoConfig?.version ||
	"0.0.0";

// Minimal semver compare: true when `remote` is a higher version than `local`.
// Tolerates missing/short segments and ignores any non-numeric suffix.
export const isNewer = (remote, local) => {
	const parse = (v) =>
		String(v || "0")
			.split(".")
			.map((p) => parseInt(p, 10) || 0);
	const r = parse(remote);
	const l = parse(local);
	const len = Math.max(r.length, l.length);
	for (let i = 0; i < len; i++) {
		const a = r[i] ?? 0;
		const b = l[i] ?? 0;
		if (a !== b) return a > b;
	}
	return false;
};
