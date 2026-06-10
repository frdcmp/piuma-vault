import { useCallback, useEffect, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { verifyScreenLockPin } from "../api/screenLockApi";
import { useAuthStore } from "../stores/authStore";
import { useScreenLockStore } from "../stores/screenLockStore";
import { colors, mono } from "../utils/theme";

// Biometric unlock is optional: the native module is only present once the app
// is rebuilt with `expo-local-authentication`. Guard the require so the lock
// still works as PIN-only on a build that doesn't include it yet.
let LocalAuthentication = null;
try {
	LocalAuthentication = require("expo-local-authentication");
} catch {
	LocalAuthentication = null;
}

const PIN_LENGTH = 6;
const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "bio", "0", "del"];

export default function ScreenLockOverlay() {
	const unlock = useScreenLockStore((s) => s.unlock);
	const logout = useAuthStore((s) => s.logout);

	const [pin, setPin] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [bioAvailable, setBioAvailable] = useState(false);

	const tryBiometric = useCallback(async () => {
		if (!LocalAuthentication) return;
		try {
			const [hw, enrolled] = await Promise.all([
				LocalAuthentication.hasHardwareAsync(),
				LocalAuthentication.isEnrolledAsync(),
			]);
			if (!hw || !enrolled) return;
			const res = await LocalAuthentication.authenticateAsync({
				promptMessage: "Unlock Piuma Vault",
				cancelLabel: "Use PIN",
			});
			if (res.success) {
				setPin("");
				setError("");
				unlock();
			}
		} catch {
			/* fall back to PIN */
		}
	}, [unlock]);

	// On mount: detect biometric support and immediately offer it.
	useEffect(() => {
		let active = true;
		(async () => {
			if (!LocalAuthentication) return;
			try {
				const [hw, enrolled] = await Promise.all([
					LocalAuthentication.hasHardwareAsync(),
					LocalAuthentication.isEnrolledAsync(),
				]);
				if (active && hw && enrolled) {
					setBioAvailable(true);
					tryBiometric();
				}
			} catch {
				/* ignore */
			}
		})();
		return () => {
			active = false;
		};
	}, [tryBiometric]);

	const submit = useCallback(
		async (value) => {
			setBusy(true);
			setError("");
			try {
				const { ok } = await verifyScreenLockPin(value);
				if (ok) {
					setPin("");
					unlock();
				} else {
					setPin("");
					setError("Wrong PIN. Try again.");
				}
			} catch (e) {
				setPin("");
				if (e?.response?.status === 429) {
					const secs = e.response.data?.retry_after_seconds;
					setError(
						`Too many attempts. Wait ${secs ? `${secs}s` : "a moment"}.`,
					);
				} else {
					setError("Couldn't verify. Try again.");
				}
			} finally {
				setBusy(false);
			}
		},
		[unlock],
	);

	const press = (key) => {
		if (busy) return;
		if (key === "bio") return tryBiometric();
		if (key === "del") {
			setError("");
			setPin((p) => p.slice(0, -1));
			return;
		}
		if (pin.length >= PIN_LENGTH) return;
		const next = pin + key;
		setError("");
		setPin(next);
		if (next.length === PIN_LENGTH) submit(next);
	};

	return (
		<View style={styles.overlay}>
			<View style={styles.card}>
				<Text style={styles.title}>VAULT LOCKED</Text>
				<Text style={styles.subtitle}>Enter your 6-digit PIN to unlock.</Text>

				<View style={styles.dots}>
					{Array.from({ length: PIN_LENGTH }).map((_, i) => (
						<View
							key={`dot-${i}`}
							style={[styles.dot, i < pin.length && styles.dotFilled]}
						/>
					))}
				</View>

				<View style={styles.errorRow}>
					{busy ? (
						<ActivityIndicator color={colors.accent} />
					) : error ? (
						<Text style={styles.error}>{error}</Text>
					) : null}
				</View>

				<View style={styles.keypad}>
					{KEYPAD.map((key) => {
						if (key === "bio" && !bioAvailable) {
							return <View key="bio" style={styles.key} />;
						}
						return (
							<Pressable
								key={key}
								onPress={() => press(key)}
								disabled={busy}
								style={({ pressed }) => [
									styles.key,
									pressed && styles.keyPressed,
								]}
							>
								<Text style={styles.keyLabel}>
									{key === "del" ? "⌫" : key === "bio" ? "☉" : key}
								</Text>
							</Pressable>
						);
					})}
				</View>

				<Pressable onPress={logout} style={styles.logout} hitSlop={8}>
					<Text style={styles.logoutLabel}>Log out instead</Text>
				</Pressable>
			</View>
		</View>
	);
}

const KEY_SIZE = 72;

const styles = StyleSheet.create({
	overlay: {
		...StyleSheet.absoluteFillObject,
		backgroundColor: colors.bg,
		alignItems: "center",
		justifyContent: "center",
		padding: 24,
		zIndex: 9999,
		elevation: 9999,
	},
	card: { alignItems: "center", width: "100%", maxWidth: 320 },
	title: {
		fontFamily: mono,
		fontSize: 20,
		letterSpacing: 2,
		color: colors.accent,
		marginBottom: 8,
	},
	subtitle: {
		fontFamily: mono,
		fontSize: 13,
		color: colors.muted,
		marginBottom: 24,
		textAlign: "center",
	},
	dots: { flexDirection: "row", gap: 14, marginBottom: 8 },
	dot: {
		width: 14,
		height: 14,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	dotFilled: { backgroundColor: colors.text, borderColor: colors.text },
	errorRow: { height: 24, justifyContent: "center", marginBottom: 8 },
	error: { fontFamily: mono, fontSize: 13, color: colors.accent3 },
	keypad: {
		flexDirection: "row",
		flexWrap: "wrap",
		width: KEY_SIZE * 3 + 24,
		justifyContent: "center",
		gap: 6,
	},
	key: {
		width: KEY_SIZE,
		height: KEY_SIZE,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.bgSoft,
		borderWidth: 2,
		borderColor: colors.border,
	},
	keyPressed: { backgroundColor: colors.panel, borderColor: colors.accent },
	keyLabel: { fontFamily: mono, fontSize: 24, color: colors.text },
	logout: { marginTop: 28 },
	logoutLabel: {
		fontFamily: mono,
		fontSize: 13,
		color: colors.muted,
		textDecorationLine: "underline",
	},
});
