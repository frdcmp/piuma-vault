import { useState } from "react";
import { useScreenLockSettings, useUpdateScreenLock } from "../../../queries";
import PvButton from "../ui/PvButton";
import pvMessage from "../ui/PvMessage";
import PvModal from "../ui/PvModal";
import PvPanel from "../ui/PvPanel";

// Inactivity-lock config. After the chosen timeout with no activity, a
// full-screen overlay blocks the app until the 6-digit PIN is entered. The PIN
// is verified server-side; it's never returned here (only `pin_set`).

const TIMEOUT_OPTIONS = [
	{ label: "1 minute", value: 60 },
	{ label: "5 minutes", value: 300 },
	{ label: "15 minutes", value: 900 },
	{ label: "30 minutes", value: 1800 },
	{ label: "1 hour", value: 3600 },
];

const ScreenLockSettings = () => {
	const { data: settings } = useScreenLockSettings();
	const updateMutation = useUpdateScreenLock();

	const enabled = !!settings?.enabled;
	const pinSet = !!settings?.pin_set;
	const timeoutSeconds = settings?.timeout_seconds || 300;

	const [pinOpen, setPinOpen] = useState(false);
	const [pin, setPin] = useState("");
	const [pinConfirm, setPinConfirm] = useState("");
	const [busy, setBusy] = useState(false);

	const save = async (payload, successMsg) => {
		setBusy(true);
		try {
			await updateMutation.mutateAsync(payload);
			if (successMsg) pvMessage.success(successMsg);
			return true;
		} catch (e) {
			pvMessage.error(
				e?.response?.data?.error || "Failed to save screen lock settings",
			);
			return false;
		} finally {
			setBusy(false);
		}
	};

	const toggleEnabled = async () => {
		if (!enabled && !pinSet) {
			pvMessage.warning("Set a PIN before enabling the screen lock");
			setPinOpen(true);
			return;
		}
		await save(
			{ enabled: !enabled },
			!enabled ? "Screen lock enabled" : "Screen lock disabled",
		);
	};

	const changeTimeout = async (value) => {
		await save(
			{ timeout_seconds: Number(value) },
			"Inactivity timeout updated",
		);
	};

	const submitPin = async () => {
		if (!/^\d{6}$/.test(pin)) {
			pvMessage.warning("PIN must be exactly 6 digits");
			return;
		}
		if (pin !== pinConfirm) {
			pvMessage.warning("PINs do not match");
			return;
		}
		const ok = await save({ pin }, "PIN saved");
		if (ok) {
			setPinOpen(false);
			setPin("");
			setPinConfirm("");
		}
	};

	const closePinModal = () => {
		setPinOpen(false);
		setPin("");
		setPinConfirm("");
	};

	return (
		<PvPanel title="Screen lock">
			<div className="vp-stack">
				<p className="vp-text vp-muted">
					Blocks the app with a 6-digit PIN after a period of inactivity, so an
					unattended screen can't be read or used. The PIN is separate from your
					password and verified securely on the server.
				</p>

				<div className="vp-row">
					{enabled ? (
						<span className="vp-tag vp-tag--green">✓ Enabled</span>
					) : (
						<span className="vp-tag">Disabled</span>
					)}
					<span className="vp-text vp-muted">
						{pinSet
							? "A PIN is set."
							: "No PIN set — set one to turn the lock on."}
					</span>
				</div>

				{!pinSet ? (
					// No PIN yet: the only action is to create one. The lock can't be
					// enabled (nor a timeout matter) until a PIN exists.
					<div>
						<PvButton
							variant="primary"
							onClick={() => setPinOpen(true)}
							disabled={busy}
						>
							Set a PIN
						</PvButton>
					</div>
				) : (
					<>
						<div className="vp-field">
							<span className="vp-label">Lock after inactivity</span>
							<select
								className="vp-input"
								value={timeoutSeconds}
								disabled={busy}
								onChange={(e) => changeTimeout(e.target.value)}
							>
								{TIMEOUT_OPTIONS.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</select>
						</div>

						<div className="vp-row" style={{ gap: 8 }}>
							<PvButton
								variant={enabled ? "danger" : "primary"}
								onClick={toggleEnabled}
								disabled={busy}
							>
								{enabled ? "Disable screen lock" : "Enable screen lock"}
							</PvButton>
							<PvButton variant="ghost" onClick={() => setPinOpen(true)}>
								Change PIN
							</PvButton>
						</div>
					</>
				)}
			</div>

			<PvModal
				open={pinOpen}
				title={pinSet ? "Change PIN" : "Set PIN"}
				onConfirm={submitPin}
				onCancel={closePinModal}
				confirmText="Save PIN"
			>
				<p className="vp-text">
					Choose a 6-digit PIN. You'll enter it to unlock the screen.
				</p>
				<div className="vp-field">
					<span className="vp-label">New PIN</span>
					<input
						type="password"
						className="vp-input"
						placeholder="••••••"
						inputMode="numeric"
						maxLength={6}
						value={pin}
						onChange={(e) =>
							setPin(e.target.value.replace(/\D/g, "").slice(0, 6))
						}
					/>
				</div>
				<div className="vp-field">
					<span className="vp-label">Confirm PIN</span>
					<input
						type="password"
						className="vp-input"
						placeholder="••••••"
						inputMode="numeric"
						maxLength={6}
						value={pinConfirm}
						onChange={(e) =>
							setPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 6))
						}
					/>
				</div>
			</PvModal>
		</PvPanel>
	);
};

export default ScreenLockSettings;
