import { Button, Switch } from "antd";
import { useEffect, useState } from "react";
import {
	useNotificationPreferences,
	useSendTestNotification,
	useUpdateNotificationPreferences,
} from "../../../queries";
import {
	disableWebPush,
	enableWebPush,
	isSubscribed,
	notificationPermission,
	webPushSupported,
} from "../../../utils/webPush";
import { pvMessage } from "../../components/ui";

/**
 * Real notification settings. "Browser notifications" drives both the Web Push
 * subscription (service worker) and the server-side `web` channel preference.
 * "Mobile push" toggles the `push` channel preference honored by the worker for
 * the Expo app. A test button fires a notification to all enabled channels.
 */
export default function NotificationSettings() {
	const { data: prefs } = useNotificationPreferences();
	const updatePrefs = useUpdateNotificationPreferences();
	const sendTest = useSendTestNotification();

	const supported = webPushSupported();
	const [subscribed, setSubscribed] = useState(false);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		isSubscribed().then(setSubscribed);
	}, []);

	const browserOn = supported && subscribed && (prefs?.web_enabled ?? true);
	const mobileOn = prefs?.push_enabled ?? true;

	const handleBrowserToggle = async (checked) => {
		setBusy(true);
		try {
			if (checked) {
				if (notificationPermission() === "denied") {
					pvMessage.error(
						"Notifications are blocked in your browser settings.",
					);
					return;
				}
				await enableWebPush();
				setSubscribed(true);
				await updatePrefs.mutateAsync({ web: true });
				pvMessage.success("Browser notifications enabled");
			} else {
				await disableWebPush();
				setSubscribed(false);
				await updatePrefs.mutateAsync({ web: false });
				pvMessage.info("Browser notifications disabled");
			}
		} catch (e) {
			pvMessage.error(
				e?.message || "Could not update browser notifications",
			);
		} finally {
			setBusy(false);
		}
	};

	const handleMobileToggle = async (checked) => {
		try {
			await updatePrefs.mutateAsync({ push: checked });
		} catch (_e) {
			pvMessage.error("Could not update mobile push preference");
		}
	};

	const handleTest = async () => {
		try {
			const res = await sendTest.mutateAsync();
			pvMessage.success(
				`Test sent (browser: ${res.web_sent}, mobile: ${res.push_sent})`,
			);
		} catch (_e) {
			pvMessage.error("Failed to send test notification");
		}
	};

	return (
		<div className="vp-stack" style={{ gap: 12 }}>
			<div className="vp-row vp-spread">
				<span className="vp-text">Browser Notifications</span>
				<Switch
					checked={browserOn}
					disabled={!supported || busy}
					loading={busy}
					onChange={handleBrowserToggle}
				/>
			</div>
			{!supported ? (
				<p className="vp-text" style={{ opacity: 0.6, fontSize: "0.8rem" }}>
					This browser doesn't support Web Push.
				</p>
			) : null}

			<div className="vp-row vp-spread">
				<span className="vp-text">Mobile Push (app)</span>
				<Switch checked={mobileOn} onChange={handleMobileToggle} />
			</div>

			<div className="vp-row vp-spread">
				<span className="vp-text">Send a test notification</span>
				<Button size="small" loading={sendTest.isPending} onClick={handleTest}>
					Send test
				</Button>
			</div>
		</div>
	);
}
