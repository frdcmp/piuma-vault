import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import {
	Modal,
	Pressable,
	StyleSheet,
	Text,
	Vibration,
	View,
} from "react-native";
import { useAlarmStore } from "../stores/alarmStore";
import { scheduleSnoozeAlarm, stopRingingNotification } from "../utils/alarm";
import { colors, mono } from "../utils/theme";

const SNOOZE_OPTIONS = [5, 10, 15];
const VIBRATION_PATTERN = [0, 600, 400];

// Loud, must-dismiss in-app alarm. Rings (looping tone + vibration) and blocks
// until Dismiss/Snooze. Driven by useAlarmStore; mount once near the app root.
export default function AlarmModal() {
	const active = useAlarmStore((s) => s.active);
	const dismiss = useAlarmStore((s) => s.dismiss);
	const player = useAudioPlayer(require("../../assets/alarm.wav"));

	useEffect(() => {
		if (!active) return;

		// The full-screen Notifee alarm is what woke us; silence its looping
		// sound now so the modal's own audio (below) doesn't double up.
		stopRingingNotification(active.notificationId);

		let cancelled = false;
		(async () => {
			try {
				await setAudioModeAsync({ playsInSilentMode: true });
				if (cancelled) return;
				player.loop = true;
				player.seekTo(0);
				player.play();
			} catch (_e) {
				/* audio is best-effort; the modal still blocks visually */
			}
		})();
		Vibration.vibrate(VIBRATION_PATTERN, true);

		return () => {
			cancelled = true;
			try {
				player.pause();
			} catch (_e) {
				/* ignore */
			}
			Vibration.cancel();
		};
	}, [active, player]);

	if (!active) return null;

	const stop = () => {
		try {
			player.pause();
		} catch (_e) {
			/* ignore */
		}
		Vibration.cancel();
		// Clear both delivery systems' notifications (Notifee local + expo remote).
		stopRingingNotification(active.notificationId);
		Notifications.dismissAllNotificationsAsync().catch(() => {});
	};

	const onDismiss = () => {
		stop();
		dismiss();
	};

	const onSnooze = (minutes) => {
		stop();
		// Re-arm as a full-screen Notifee alarm; it re-presents this modal when
		// it fires (App.js listeners / getInitialNotification).
		scheduleSnoozeAlarm({
			title: active.title,
			body: active.body,
			tag: active.tag,
			minutes,
		});
		dismiss();
	};

	return (
		<Modal visible transparent animationType="fade" onRequestClose={() => {}}>
			<View style={styles.overlay}>
				<View style={styles.card}>
					<Text style={styles.bell}>🔔</Text>
					<Text style={styles.title}>{active.title}</Text>
					{active.body ? <Text style={styles.body}>{active.body}</Text> : null}

					<Pressable
						style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
						onPress={onDismiss}
					>
						<Text style={styles.dismissText}>DISMISS</Text>
					</Pressable>

					<View style={styles.snoozeRow}>
						{SNOOZE_OPTIONS.map((m) => (
							<Pressable
								key={m}
								style={({ pressed }) => [styles.snooze, pressed && styles.pressed]}
								onPress={() => onSnooze(m)}
							>
								<Text style={styles.snoozeText}>{m}m</Text>
							</Pressable>
						))}
					</View>
					<Text style={styles.snoozeLabel}>snooze</Text>
				</View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	overlay: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.85)",
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 28,
	},
	card: {
		width: "100%",
		alignItems: "center",
		gap: 14,
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.accent3,
		paddingHorizontal: 20,
		paddingVertical: 30,
	},
	bell: { fontSize: 44 },
	title: {
		color: colors.text,
		fontFamily: mono,
		fontSize: 18,
		fontWeight: "700",
		textAlign: "center",
	},
	body: {
		color: colors.muted,
		fontFamily: mono,
		fontSize: 13,
		textAlign: "center",
	},
	dismiss: {
		marginTop: 8,
		paddingHorizontal: 40,
		paddingVertical: 12,
		borderWidth: 2,
		borderColor: colors.accent3,
		backgroundColor: colors.bgSoft,
	},
	dismissText: {
		color: colors.accent3,
		fontFamily: mono,
		fontSize: 14,
		fontWeight: "700",
		letterSpacing: 2,
	},
	snoozeRow: { flexDirection: "row", gap: 10, marginTop: 4 },
	snooze: {
		paddingHorizontal: 18,
		paddingVertical: 8,
		borderWidth: 2,
		borderColor: colors.border,
		backgroundColor: colors.bg,
	},
	snoozeText: {
		color: colors.text,
		fontFamily: mono,
		fontSize: 13,
		fontWeight: "700",
	},
	snoozeLabel: {
		color: colors.muted,
		fontFamily: mono,
		fontSize: 10,
		letterSpacing: 1,
	},
});
