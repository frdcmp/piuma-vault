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
import { colors, mono } from "../utils/theme";

const SNOOZE_OPTIONS = [5, 10, 15];
const VIBRATION_PATTERN = [0, 600, 400];

// Re-fire the same alert as a local notification after `minutes`; the listeners
// in App.js will re-present it as an alarm when it fires.
async function scheduleSnooze(alarm, minutes) {
	try {
		await Notifications.scheduleNotificationAsync({
			content: {
				title: alarm.title,
				body: alarm.body || "",
				data: { tag: alarm.tag, snoozed: true },
			},
			trigger: {
				type: Notifications.SchedulableTriggerInputTypes.DATE,
				date: new Date(Date.now() + minutes * 60 * 1000),
			},
		});
	} catch (_e) {
		/* best-effort */
	}
}

// Loud, must-dismiss in-app alarm. Rings (looping tone + vibration) and blocks
// until Dismiss/Snooze. Driven by useAlarmStore; mount once near the app root.
export default function AlarmModal() {
	const active = useAlarmStore((s) => s.active);
	const dismiss = useAlarmStore((s) => s.dismiss);
	const player = useAudioPlayer(require("../../assets/alarm.wav"));

	useEffect(() => {
		if (!active) return;

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
		Notifications.dismissAllNotificationsAsync().catch(() => {});
	};

	const onDismiss = () => {
		stop();
		dismiss();
	};

	const onSnooze = (minutes) => {
		stop();
		scheduleSnooze(active, minutes);
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
