import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
	ActivityIndicator,
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ConfirmModal from "../../components/ConfirmModal";
import SettingsHeader from "../../components/SettingsHeader";
import {
	useRevokeTrustedDevice,
	useTrustedDevices,
} from "../../queries/devicesQuery";
import {
	useScreenLockSettings,
	useUpdateScreenLock,
} from "../../queries/screenLockQuery";
import { formatDate } from "../../utils/dateTime";
import { colors } from "../../utils/theme";

const TIMEOUT_OPTIONS = [
	{ label: "1 min", value: 60 },
	{ label: "5 min", value: 300 },
	{ label: "15 min", value: 900 },
	{ label: "30 min", value: 1800 },
	{ label: "1 hr", value: 3600 },
];

function PinModal({ visible, pinSet, onSubmit, onCancel, busy }) {
	const [pin, setPin] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState("");

	const clean = (v) => v.replace(/\D/g, "").slice(0, 6);

	const submit = () => {
		if (!/^\d{6}$/.test(pin)) {
			setError("PIN must be exactly 6 digits");
			return;
		}
		if (pin !== confirm) {
			setError("PINs do not match");
			return;
		}
		onSubmit(pin);
		setPin("");
		setConfirm("");
		setError("");
	};

	const cancel = () => {
		setPin("");
		setConfirm("");
		setError("");
		onCancel();
	};

	return (
		<Modal
			visible={visible}
			transparent
			animationType="fade"
			onRequestClose={cancel}
		>
			<Pressable style={styles.overlay} onPress={cancel}>
				<Pressable style={styles.modalCard} onPress={() => {}}>
					<Text style={styles.modalTitle}>
						{pinSet ? "Change PIN" : "Set PIN"}
					</Text>
					<Text style={styles.modalMsg}>
						Choose a 6-digit PIN. You'll enter it to unlock the screen.
					</Text>
					<TextInput
						style={styles.input}
						placeholder="New PIN"
						placeholderTextColor={colors.muted}
						keyboardType="number-pad"
						secureTextEntry
						maxLength={6}
						value={pin}
						onChangeText={(v) => setPin(clean(v))}
					/>
					<TextInput
						style={styles.input}
						placeholder="Confirm PIN"
						placeholderTextColor={colors.muted}
						keyboardType="number-pad"
						secureTextEntry
						maxLength={6}
						value={confirm}
						onChangeText={(v) => setConfirm(clean(v))}
					/>
					{error ? <Text style={styles.error}>{error}</Text> : null}
					<View style={styles.modalActions}>
						<Pressable
							onPress={cancel}
							style={({ pressed }) => [
								styles.btn,
								pressed && styles.btnPressed,
							]}
						>
							<Text style={styles.btnText}>Cancel</Text>
						</Pressable>
						<Pressable
							onPress={submit}
							disabled={busy}
							style={({ pressed }) => [
								styles.btn,
								styles.btnPrimary,
								pressed && styles.btnPressed,
							]}
						>
							<Text style={[styles.btnText, styles.btnTextPrimary]}>
								Save PIN
							</Text>
						</Pressable>
					</View>
				</Pressable>
			</Pressable>
		</Modal>
	);
}

export default function SecurityScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const { data: lock, isLoading: lockLoading } = useScreenLockSettings();
	const updateLock = useUpdateScreenLock();
	const { data: devices, isLoading: devicesLoading } = useTrustedDevices();
	const revoke = useRevokeTrustedDevice();

	const [pinOpen, setPinOpen] = useState(false);
	const [pendingRevoke, setPendingRevoke] = useState(null);

	const enabled = !!lock?.enabled;
	const pinSet = !!lock?.pin_set;
	const timeoutSeconds = lock?.timeout_seconds || 300;
	const deviceList = devices || [];

	const toggleEnabled = () => {
		if (!enabled && !pinSet) {
			setPinOpen(true);
			return;
		}
		updateLock.mutate({ enabled: !enabled });
	};

	const savePin = (pin) => {
		updateLock.mutate({ pin }, { onSuccess: () => setPinOpen(false) });
	};

	const confirmRevoke = () => {
		const dev = pendingRevoke;
		setPendingRevoke(null);
		if (dev) revoke.mutate(dev.id);
	};

	return (
		<View style={styles.root}>
			<SettingsHeader title="Security" onBack={() => navigation.goBack()} />
			<ScrollView
				contentContainerStyle={[
					styles.scroll,
					{ paddingBottom: insets.bottom + 24 },
				]}
			>
				{/* ── Screen lock ─────────────────────────────────────────── */}
				<Text style={styles.sectionTitle}>Screen lock</Text>
				<View style={styles.panel}>
					<Text style={styles.panelDesc}>
						Blocks the app with a 6-digit PIN after a period of inactivity. The
						PIN is separate from your password and verified on the server.
					</Text>
					{lockLoading ? (
						<ActivityIndicator color={colors.accent} style={styles.loader} />
					) : (
						<>
							<View style={styles.statusRow}>
								<View
									style={[styles.tag, enabled ? styles.tagOn : styles.tagOff]}
								>
									<Text style={[styles.tagText, enabled && styles.tagTextOn]}>
										{enabled ? "✓ Enabled" : "Disabled"}
									</Text>
								</View>
								<Text style={styles.statusHint}>
									{pinSet ? "A PIN is set." : "No PIN set yet."}
								</Text>
							</View>

							{pinSet ? (
								<>
									<Text style={styles.label}>Lock after inactivity</Text>
									<View style={styles.chips}>
										{TIMEOUT_OPTIONS.map((o) => {
											const active = o.value === timeoutSeconds;
											return (
												<Pressable
													key={o.value}
													onPress={() =>
														updateLock.mutate({ timeout_seconds: o.value })
													}
													style={[styles.chip, active && styles.chipActive]}
												>
													<Text
														style={[
															styles.chipText,
															active && styles.chipTextActive,
														]}
													>
														{o.label}
													</Text>
												</Pressable>
											);
										})}
									</View>
									<View style={styles.btnRow}>
										<Pressable
											onPress={toggleEnabled}
											disabled={updateLock.isPending}
											style={({ pressed }) => [
												styles.actionBtn,
												enabled ? styles.actionDanger : styles.actionPrimary,
												pressed && styles.btnPressed,
											]}
										>
											<Text
												style={[
													styles.actionBtnText,
													enabled
														? styles.actionTextDanger
														: styles.actionTextPrimary,
												]}
											>
												{enabled ? "Disable lock" : "Enable lock"}
											</Text>
										</Pressable>
										<Pressable
											onPress={() => setPinOpen(true)}
											style={({ pressed }) => [
												styles.actionBtn,
												pressed && styles.btnPressed,
											]}
										>
											<Text style={styles.actionBtnText}>Change PIN</Text>
										</Pressable>
									</View>
								</>
							) : (
								<Pressable
									onPress={() => setPinOpen(true)}
									style={({ pressed }) => [
										styles.actionBtn,
										styles.actionPrimary,
										styles.selfStart,
										pressed && styles.btnPressed,
									]}
								>
									<Text
										style={[styles.actionBtnText, styles.actionTextPrimary]}
									>
										Set a PIN
									</Text>
								</Pressable>
							)}
						</>
					)}
				</View>

				{/* ── Trusted devices ─────────────────────────────────────── */}
				<Text style={styles.sectionTitle}>Trusted devices</Text>
				<View style={styles.panel}>
					<Text style={styles.panelDesc}>
						These devices skip the OTP prompt for 30 days after their last
						verified login. Revoke any you don't recognize.
					</Text>
					{devicesLoading ? (
						<ActivityIndicator color={colors.accent} style={styles.loader} />
					) : deviceList.length === 0 ? (
						<Text style={styles.faint}>No trusted devices.</Text>
					) : (
						deviceList.map((d) => (
							<View key={d.id} style={styles.device}>
								<View style={styles.deviceText}>
									<Text style={styles.deviceName}>
										{d.label || "Unknown device"}
									</Text>
									<Text style={styles.deviceMeta}>
										Added {d.created_at ? formatDate(d.created_at) : "—"} · Last
										used {d.last_used_at ? formatDate(d.last_used_at) : "never"}
									</Text>
									<Text style={styles.deviceExpires}>
										Expires {d.expires_at ? formatDate(d.expires_at) : "—"}
									</Text>
								</View>
								<Pressable
									onPress={() => setPendingRevoke(d)}
									hitSlop={8}
									style={styles.revokeBtn}
								>
									<Ionicons
										name="close-circle-outline"
										size={22}
										color={colors.accent3}
									/>
								</Pressable>
							</View>
						))
					)}
				</View>
			</ScrollView>

			<PinModal
				visible={pinOpen}
				pinSet={pinSet}
				busy={updateLock.isPending}
				onSubmit={savePin}
				onCancel={() => setPinOpen(false)}
			/>
			<ConfirmModal
				visible={pendingRevoke != null}
				title="Revoke device"
				message={`Revoke "${pendingRevoke?.label || "Unknown device"}"? It will need to pass the OTP prompt on the next login.`}
				confirmText="Revoke"
				onConfirm={confirmRevoke}
				onCancel={() => setPendingRevoke(null)}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: colors.bg },
	scroll: { padding: 12, gap: 8 },
	sectionTitle: {
		color: colors.muted,
		fontSize: 12,
		textTransform: "uppercase",
		letterSpacing: 1,
		marginTop: 8,
		marginBottom: 4,
		marginLeft: 4,
	},
	panel: {
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 4,
		padding: 16,
		gap: 12,
	},
	panelDesc: { color: colors.muted, fontSize: 13, lineHeight: 19 },
	loader: { alignSelf: "flex-start" },
	statusRow: { flexDirection: "row", alignItems: "center", gap: 10 },
	tag: {
		paddingHorizontal: 8,
		paddingVertical: 3,
		borderRadius: 3,
		borderWidth: 1,
	},
	tagOn: { borderColor: colors.accent2 },
	tagOff: { borderColor: colors.border },
	tagText: { color: colors.muted, fontSize: 12, fontWeight: "600" },
	tagTextOn: { color: colors.accent2 },
	statusHint: { color: colors.muted, fontSize: 13 },
	label: { color: colors.text, fontSize: 13, fontWeight: "600" },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	chip: {
		paddingHorizontal: 12,
		paddingVertical: 7,
		borderRadius: 3,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
	},
	chipActive: { borderColor: colors.accent, backgroundColor: colors.bg },
	chipText: { color: colors.muted, fontSize: 13 },
	chipTextActive: { color: colors.accent, fontWeight: "600" },
	btnRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
	selfStart: { alignSelf: "flex-start" },
	actionBtn: {
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderRadius: 4,
		borderWidth: 1,
		borderColor: colors.border,
	},
	actionPrimary: { borderColor: colors.accent },
	actionDanger: { borderColor: colors.accent3 },
	actionBtnText: { color: colors.text, fontSize: 14, fontWeight: "600" },
	actionTextPrimary: { color: colors.accent },
	actionTextDanger: { color: colors.accent3 },
	btnPressed: { backgroundColor: colors.bgSoft },
	faint: { color: colors.muted, fontSize: 14 },
	device: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 10,
		borderTopWidth: 1,
		borderTopColor: colors.border,
		paddingTop: 12,
	},
	deviceText: { flex: 1 },
	deviceName: { color: colors.text, fontSize: 15, fontWeight: "600" },
	deviceMeta: {
		color: colors.muted,
		fontSize: 12,
		marginTop: 3,
		lineHeight: 17,
	},
	deviceExpires: { color: colors.accent, fontSize: 12, marginTop: 1 },
	revokeBtn: { padding: 2 },
	// PIN modal
	overlay: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.6)",
		alignItems: "center",
		justifyContent: "center",
		padding: 24,
	},
	modalCard: {
		width: "100%",
		maxWidth: 360,
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 6,
		padding: 20,
	},
	modalTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
	modalMsg: { color: colors.muted, fontSize: 13, marginTop: 8, lineHeight: 19 },
	input: {
		marginTop: 12,
		paddingHorizontal: 12,
		paddingVertical: 10,
		borderRadius: 4,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		color: colors.text,
		fontSize: 16,
		letterSpacing: 4,
	},
	error: { color: colors.accent3, fontSize: 13, marginTop: 8 },
	modalActions: {
		flexDirection: "row",
		justifyContent: "flex-end",
		gap: 10,
		marginTop: 18,
	},
	btn: {
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderRadius: 4,
		borderWidth: 1,
		borderColor: colors.border,
	},
	btnPrimary: { borderColor: colors.accent },
	btnText: { color: colors.text, fontSize: 14, fontWeight: "600" },
	btnTextPrimary: { color: colors.accent },
});
