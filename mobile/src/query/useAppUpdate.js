import { useQuery } from "@tanstack/react-query";
import { Linking, Platform } from "react-native";
import { fetchAppManifest, signedUrl } from "../api/storageApi";
import { CURRENT_VERSION, isNewer, MANIFEST_KEY } from "../config/appUpdate";

/**
 * Whether a newer standalone APK is available for this build. Android-only —
 * iOS can't sideload APKs — and fails silently (no error UI; just no prompt).
 * Reads the manifest through our backend. Returns the query plus
 * `{ latest, updateAvailable }`.
 */
export const useAppUpdate = (options = {}) => {
	const enabled = Platform.OS === "android" && (options.enabled ?? true);
	const query = useQuery({
		queryKey: ["appUpdate", MANIFEST_KEY],
		queryFn: fetchAppManifest,
		enabled,
		staleTime: 30 * 60 * 1000,
		retry: 1,
	});

	const latest = query.data ?? null;
	const updateAvailable =
		enabled && !!latest && isNewer(latest.version, CURRENT_VERSION);

	return { ...query, latest, updateAvailable };
};

/**
 * Mint a 1-hour signed URL for the APK and hand it to the OS to download/install.
 * Returns true if a link was opened.
 */
export const openApkDownload = async (latest) => {
	if (!latest?.apkKey) return false;
	const { url } = await signedUrl({ key: latest.apkKey, expiresInSecs: 3600 });
	await Linking.openURL(url);
	return true;
};
