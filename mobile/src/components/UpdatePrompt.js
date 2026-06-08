import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { CURRENT_VERSION } from "../config/appUpdate";
import { openApkDownload, useAppUpdate } from "../query/useAppUpdate";

// Checks for a newer standalone APK when the app opens and, if one exists,
// prompts once per session with a one-tap download. Android-only (the hook
// no-ops elsewhere). Renders nothing — mount it once inside the authed tree.
export default function UpdatePrompt() {
	const { updateAvailable, latest } = useAppUpdate();
	const prompted = useRef(false);

	useEffect(() => {
		if (!updateAvailable || prompted.current) return;
		prompted.current = true;
		Alert.alert(
			`Update available — v${latest.version}`,
			latest.notes ||
				`You're on v${CURRENT_VERSION}. A newer build is ready to download.`,
			[
				{ text: "Later", style: "cancel" },
				{
					text: "Download",
					onPress: () => openApkDownload(latest).catch(() => {}),
				},
			],
		);
	}, [updateAvailable, latest]);

	return null;
}
