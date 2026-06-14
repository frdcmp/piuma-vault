import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import {
	deleteTrustedDevice,
	getTrustedDevices,
	postOtpDisable,
	postOtpSetup,
	postOtpVerifySetup,
} from "../../../api/auth";
import { useUserMe } from "../../../queries";
import { formatDate } from "../../../utils/dateTime";
import PvButton from "../ui/PvButton";
import pvMessage from "../ui/PvMessage";
import PvModal from "../ui/PvModal";
import PvPanel from "../ui/PvPanel";
import ScreenLockSettings from "./ScreenLockSettings";

// Security settings tab.
//
// States:
//   - "idle"      — OTP disabled, show "Enable" button.
//   - "setup"     — got a secret/URI from the backend, render QR + verify input.
//   - "codes"     — verify succeeded, show backup codes once.
//   - "enabled"   — OTP enabled, show trusted devices + disable button.
//   - "disabling" — modal for re-entering password + current code.

const SecuritySettings = () => {
	const { data: me, refetch: refetchMe } = useUserMe();
	const otpEnabled = !!me?.otp_enabled;

	const [phase, setPhase] = useState(otpEnabled ? "enabled" : "idle");
	const [setupData, setSetupData] = useState(null); // { secret, otpauth_uri, issuer }
	const [verifyCode, setVerifyCode] = useState("");
	const [backupCodes, setBackupCodes] = useState(null);
	const [busy, setBusy] = useState(false);

	const [devices, setDevices] = useState([]);
	const [disableOpen, setDisableOpen] = useState(false);
	const [disablePwd, setDisablePwd] = useState("");
	const [disableCode, setDisableCode] = useState("");

	useEffect(() => {
		setPhase(otpEnabled ? "enabled" : "idle");
	}, [otpEnabled]);

	useEffect(() => {
		if (phase !== "enabled") return;
		getTrustedDevices()
			.then(setDevices)
			.catch(() => setDevices([]));
	}, [phase]);

	const startEnroll = async () => {
		setBusy(true);
		try {
			const data = await postOtpSetup();
			setSetupData(data);
			setVerifyCode("");
			setPhase("setup");
		} catch (e) {
			pvMessage.error(e?.response?.data || "Failed to start OTP setup");
		} finally {
			setBusy(false);
		}
	};

	const confirmEnroll = async () => {
		if (!/^\d{6}$/.test(verifyCode.trim())) {
			pvMessage.warning(
				"Enter the 6-digit code from your authenticator app",
			);
			return;
		}
		setBusy(true);
		try {
			const data = await postOtpVerifySetup({ code: verifyCode.trim() });
			setBackupCodes(data.backup_codes || []);
			setPhase("codes");
			await refetchMe();
		} catch (e) {
			pvMessage.error(e?.response?.data || "Code did not verify");
		} finally {
			setBusy(false);
		}
	};

	const finishEnroll = () => {
		setSetupData(null);
		setVerifyCode("");
		setBackupCodes(null);
		setPhase("enabled");
	};

	const downloadCodes = () => {
		if (!backupCodes?.length) return;
		const blob = new Blob(
			[
				`Piuma Vault two-factor backup codes\n\nEach code can be used once. Store somewhere safe.\n\n${backupCodes.join("\n")}\n`,
			],
			{ type: "text/plain;charset=utf-8" },
		);
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "piuma-backup-codes.txt";
		a.click();
		URL.revokeObjectURL(url);
	};

	const submitDisable = async () => {
		if (!disablePwd || !/^\d{6}$/.test(disableCode.trim())) {
			pvMessage.warning("Enter your password and a 6-digit code");
			return;
		}
		setBusy(true);
		try {
			await postOtpDisable({
				password: disablePwd,
				code: disableCode.trim(),
			});
			pvMessage.success("Two-factor authentication disabled");
			setDisableOpen(false);
			setDisablePwd("");
			setDisableCode("");
			await refetchMe();
			setPhase("idle");
		} catch (e) {
			pvMessage.error(e?.response?.data || "Failed to disable");
		} finally {
			setBusy(false);
		}
	};

	const revoke = async (id) => {
		try {
			await deleteTrustedDevice(id);
			setDevices((ds) => ds.filter((d) => d.id !== id));
			pvMessage.success("Device revoked");
		} catch (e) {
			pvMessage.error(e?.response?.data || "Failed to revoke");
		}
	};

	return (
		<div className="vp-stack">
			<PvPanel title="Two-factor authentication">
				{phase === "idle" && (
					<div className="vp-stack">
						<p className="vp-text">
							Add a second factor (TOTP) to logins. Works with Google
							Authenticator, 1Password, Bitwarden, Authy, and others.
						</p>
						<div>
							<PvButton
								variant="primary"
								onClick={startEnroll}
								disabled={busy}
							>
								Enable two-factor authentication
							</PvButton>
						</div>
					</div>
				)}

				{phase === "setup" && setupData && (
					<div className="vp-stack">
						<p className="vp-text vp-muted">
							Scan the QR code with your authenticator app, then enter the
							6-digit code below to confirm.
						</p>
						<div className="vp-row vp-row--wrap" style={{ gap: 24 }}>
							<div style={{ background: "#fff", padding: 12 }}>
								<QRCodeSVG value={setupData.otpauth_uri} size={184} />
							</div>
							<div style={{ flex: 1, minWidth: 260 }}>
								<div className="vp-field">
									<span className="vp-label">Can't scan? Enter this key</span>
									<code className="vp-input" style={{ wordBreak: "break-all" }}>
										{setupData.secret}
									</code>
								</div>
								<div className="vp-field">
									<span className="vp-label">Verification code</span>
									<input
										className="vp-input"
										placeholder="123456"
										inputMode="numeric"
										maxLength={6}
										value={verifyCode}
										onChange={(e) => setVerifyCode(e.target.value)}
									/>
								</div>
								<div className="vp-row" style={{ gap: 8 }}>
									<PvButton
										variant="primary"
										onClick={confirmEnroll}
										disabled={busy}
									>
										Verify and enable
									</PvButton>
									<PvButton
										variant="ghost"
										onClick={() => setPhase("idle")}
									>
										Cancel
									</PvButton>
								</div>
							</div>
						</div>
					</div>
				)}

				{phase === "codes" && backupCodes && (
					<div className="vp-stack">
						<p className="vp-text vp-accent">Save these backup codes now</p>
						<p className="vp-text vp-muted">
							Each code can be used once to log in if you lose your
							authenticator device. They will not be shown again.
						</p>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "1fr 1fr",
								gap: 8,
								background: "var(--vp-bg-soft)",
								border: "2px solid var(--vp-border)",
								padding: 16,
								fontFamily: "var(--vp-font)",
							}}
						>
							{backupCodes.map((c) => (
								<div key={c} className="vp-text">
									{c}
								</div>
							))}
						</div>
						<div className="vp-row" style={{ gap: 8 }}>
							<PvButton onClick={downloadCodes}>Download .txt</PvButton>
							<PvButton variant="primary" onClick={finishEnroll}>
								I've saved them
							</PvButton>
						</div>
					</div>
				)}

				{phase === "enabled" && (
					<div className="vp-stack">
						<div className="vp-row">
							<span className="vp-tag vp-tag--green">✓ Enabled</span>
							<span className="vp-text vp-muted">
								Two-factor authentication is active on your account.
							</span>
						</div>
						<div>
							<PvButton
								variant="danger"
								onClick={() => setDisableOpen(true)}
							>
								Disable two-factor authentication
							</PvButton>
						</div>
					</div>
				)}
			</PvPanel>

			<ScreenLockSettings />

			{phase === "enabled" && (
				<PvPanel title="Trusted devices">
					<p className="vp-text vp-muted">
						These devices skip the OTP prompt for 30 days after their last
						verified login. Revoke any you don't recognize.
					</p>
					{devices.length === 0 ? (
						<p className="vp-text vp-faint">No trusted devices.</p>
					) : (
						<div className="vp-stack" style={{ gap: 10 }}>
							{devices.map((d) => (
								<div
									key={d.id}
									className="vp-card vp-row vp-spread"
									style={{ alignItems: "flex-start" }}
								>
									<div>
										<p className="vp-card-title">
											{d.label || "Unknown device"}
										</p>
										<p className="vp-card-desc">
											Added {d.created_at ? formatDate(d.created_at) : "—"}
											{" · "}
											Last used{" "}
											{d.last_used_at ? formatDate(d.last_used_at) : "never"}
											{" · "}
											<span className="vp-accent">
												Expires {d.expires_at ? formatDate(d.expires_at) : "—"}
											</span>
										</p>
									</div>
									<PvButton
										variant="danger"
										size="sm"
										onClick={() => revoke(d.id)}
									>
										Revoke
									</PvButton>
								</div>
							))}
						</div>
					)}
				</PvPanel>
			)}

			<PvModal
				open={disableOpen}
				title="Disable two-factor authentication"
				onConfirm={submitDisable}
				onCancel={() => setDisableOpen(false)}
				confirmText="Disable"
				danger
			>
				<p className="vp-text">
					Confirm your password and a current 6-digit code to disable OTP. This
					also revokes all trusted devices and invalidates backup codes.
				</p>
				<div className="vp-field">
					<span className="vp-label">Password</span>
					<input
						type="password"
						className="vp-input"
						placeholder="Password"
						value={disablePwd}
						onChange={(e) => setDisablePwd(e.target.value)}
					/>
				</div>
				<div className="vp-field">
					<span className="vp-label">Current code</span>
					<input
						className="vp-input"
						placeholder="123456"
						inputMode="numeric"
						maxLength={6}
						value={disableCode}
						onChange={(e) => setDisableCode(e.target.value)}
					/>
				</div>
			</PvModal>
		</div>
	);
};

export default SecuritySettings;
