import { useState } from "react";
import {
	useCreateEmailAccount,
	useDeleteEmailAccount,
	useEmailAccounts,
	useSetDefaultEmailAccount,
	useTestEmailImap,
	useTestEmailSmtp,
	useUpdateEmailAccount,
} from "../../../queries";
import {
	PvButton,
	PvCheckbox,
	PvModal,
	PvPanel,
	pvMessage,
} from "../../components/ui";

const SECURITY_OPTS = [
	{ id: "starttls", label: "STARTTLS (587)" },
	{ id: "ssl", label: "SSL/TLS (465 / 993)" },
	{ id: "none", label: "None (plaintext)" },
];

const blankForm = () => ({
	label: "",
	email_address: "",
	send_enabled: false,
	smtp_host: "",
	smtp_port: 587,
	smtp_security: "starttls",
	smtp_username: "",
	smtp_password: "",
	read_enabled: false,
	imap_host: "",
	imap_port: 993,
	imap_security: "ssl",
	imap_username: "",
	imap_password: "",
	is_default: false,
});

// Seed a card's editable form from a saved account; passwords stay blank
// (write-only — the server returns only `*_password_set` booleans).
const formFromAccount = (a) => ({
	label: a.label || "",
	email_address: a.email_address || "",
	send_enabled: !!a.send_enabled,
	smtp_host: a.smtp_host || "",
	smtp_port: a.smtp_port ?? 587,
	smtp_security: a.smtp_security || "starttls",
	smtp_username: a.smtp_username || "",
	smtp_password: "",
	read_enabled: !!a.read_enabled,
	imap_host: a.imap_host || "",
	imap_port: a.imap_port ?? 993,
	imap_security: a.imap_security || "ssl",
	imap_username: a.imap_username || "",
	imap_password: "",
	is_default: !!a.is_default,
});

const Chip = ({ on }) =>
	on ? (
		<span className="vp-tag vp-tag--green vp-svc-chip">set</span>
	) : (
		<span className="vp-tag vp-tag--red vp-svc-chip">unset</span>
	);

const TestResult = ({ result }) =>
	result ? (
		<span
			className={`vp-svc-result ${result.ok ? "is-ok" : "is-err"}`}
			title={result.message}
		>
			{result.ok ? "✓" : "✕"} {result.message}
		</span>
	) : null;

// One account (saved or a new draft). Holds its own form state so cards edit
// independently. `account === null` means a brand-new draft.
const AccountCard = ({ account, onCancelDraft, onDeleteRequest }) => {
	const isNew = !account;
	const [form, setForm] = useState(() =>
		account ? formFromAccount(account) : blankForm(),
	);
	const [smtpResult, setSmtpResult] = useState(null);
	const [imapResult, setImapResult] = useState(null);

	const create = useCreateEmailAccount();
	const update = useUpdateEmailAccount();
	const setDefault = useSetDefaultEmailAccount();
	const testSmtp = useTestEmailSmtp();
	const testImap = useTestEmailImap();

	const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
	const setBool = (key) => (checked) =>
		setForm((f) => ({ ...f, [key]: checked }));

	const buildPayload = () => {
		const p = {
			label: form.label.trim(),
			email_address: form.email_address.trim(),
			send_enabled: form.send_enabled,
			smtp_host: form.smtp_host.trim(),
			smtp_port: Number(form.smtp_port) || 587,
			smtp_security: form.smtp_security,
			smtp_username: form.smtp_username.trim(),
			read_enabled: form.read_enabled,
			imap_host: form.imap_host.trim(),
			imap_port: Number(form.imap_port) || 993,
			imap_security: form.imap_security,
			imap_username: form.imap_username.trim(),
			is_default: form.is_default,
		};
		// Passwords are leave-blank-to-keep: only send when typed.
		if (form.smtp_password.trim()) p.smtp_password = form.smtp_password.trim();
		if (form.imap_password.trim()) p.imap_password = form.imap_password.trim();
		return p;
	};

	const handleSave = async () => {
		if (!form.label.trim() || !form.email_address.trim()) {
			pvMessage.error("Label and email address are required");
			return;
		}
		try {
			if (isNew) {
				await create.mutateAsync(buildPayload());
				pvMessage.success("Account added");
				onCancelDraft?.();
			} else {
				await update.mutateAsync({ id: account.id, ...buildPayload() });
				setForm((f) => ({ ...f, smtp_password: "", imap_password: "" }));
				pvMessage.success("Account saved");
			}
		} catch (err) {
			pvMessage.error(err?.response?.data?.error || "Failed to save");
		}
	};

	const handleSetDefault = async () => {
		try {
			await setDefault.mutateAsync(account.id);
			pvMessage.success("System sender updated");
		} catch (err) {
			pvMessage.error(
				err?.response?.data?.error || "Failed to set system sender",
			);
		}
	};

	const runTest = async (mutation, setResult, payload) => {
		setResult(null);
		try {
			setResult(await mutation.mutateAsync(payload));
		} catch (err) {
			setResult({
				ok: false,
				message: err?.response?.data?.error || "Test failed",
			});
		}
	};

	const smtpTestPayload = () => {
		const p = {
			id: account?.id,
			host: form.smtp_host.trim(),
			port: Number(form.smtp_port) || 587,
			security: form.smtp_security,
			username: form.smtp_username.trim(),
			to: form.email_address.trim(),
		};
		if (form.smtp_password.trim()) p.password = form.smtp_password.trim();
		return p;
	};
	const imapTestPayload = () => {
		const p = {
			id: account?.id,
			host: form.imap_host.trim(),
			port: Number(form.imap_port) || 993,
			security: form.imap_security,
			username: form.imap_username.trim(),
		};
		if (form.imap_password.trim()) p.password = form.imap_password.trim();
		return p;
	};

	const busy = create.isPending || update.isPending;

	return (
		<div className="vp-email-card">
			<div className="vp-row" style={{ gap: 12, flexWrap: "wrap" }}>
				<div
					className="vp-field"
					style={{ flex: "1 1 200px", marginBottom: 0 }}
				>
					<span className="vp-label">Label</span>
					<input
						className="vp-input"
						type="text"
						placeholder="Personal Gmail"
						value={form.label}
						onChange={set("label")}
					/>
				</div>
				<div
					className="vp-field"
					style={{ flex: "1 1 240px", marginBottom: 0 }}
				>
					<span className="vp-label">
						Email address{" "}
						{!isNew && account.is_default && (
							<span className="vp-tag vp-tag--green vp-svc-chip">
								system sender
							</span>
						)}
					</span>
					<input
						className="vp-input"
						type="email"
						spellCheck={false}
						placeholder="you@example.com"
						value={form.email_address}
						onChange={set("email_address")}
					/>
				</div>
			</div>

			{/* Sending (SMTP) */}
			<PvCheckbox
				checked={form.send_enabled}
				onChange={setBool("send_enabled")}
				label="Enable sending (SMTP)"
			/>
			{form.send_enabled && (
				<div className="vp-email-section">
					<div className="vp-row" style={{ gap: 12, flexWrap: "wrap" }}>
						<div
							className="vp-field"
							style={{ flex: "2 1 220px", marginBottom: 0 }}
						>
							<span className="vp-label">SMTP Host</span>
							<input
								className="vp-input"
								type="text"
								spellCheck={false}
								placeholder="smtp.gmail.com"
								value={form.smtp_host}
								onChange={set("smtp_host")}
							/>
						</div>
						<div
							className="vp-field"
							style={{ flex: "0 1 100px", marginBottom: 0 }}
						>
							<span className="vp-label">Port</span>
							<input
								className="vp-input"
								type="number"
								value={form.smtp_port}
								onChange={set("smtp_port")}
							/>
						</div>
						<div
							className="vp-field"
							style={{ flex: "1 1 160px", marginBottom: 0 }}
						>
							<span className="vp-label">Security</span>
							<select
								className="vp-input"
								value={form.smtp_security}
								onChange={set("smtp_security")}
							>
								{SECURITY_OPTS.map((o) => (
									<option key={o.id} value={o.id}>
										{o.label}
									</option>
								))}
							</select>
						</div>
					</div>
					<div className="vp-row" style={{ gap: 12, flexWrap: "wrap" }}>
						<div
							className="vp-field"
							style={{ flex: "1 1 220px", marginBottom: 0 }}
						>
							<span className="vp-label">Username</span>
							<input
								className="vp-input"
								type="text"
								spellCheck={false}
								autoComplete="off"
								placeholder="defaults to the email address"
								value={form.smtp_username}
								onChange={set("smtp_username")}
							/>
						</div>
						<div
							className="vp-field"
							style={{ flex: "1 1 220px", marginBottom: 0 }}
						>
							<span className="vp-label">
								Password / App password{" "}
								{!isNew && <Chip on={account.smtp_password_set} />}
							</span>
							<input
								className="vp-input"
								type="password"
								autoComplete="new-password"
								placeholder={
									!isNew && account.smtp_password_set
										? "•••• configured — leave blank to keep"
										: "app password"
								}
								value={form.smtp_password}
								onChange={set("smtp_password")}
							/>
						</div>
					</div>
					<div className="vp-svc-test">
						<PvButton
							size="sm"
							onClick={() =>
								runTest(testSmtp, setSmtpResult, smtpTestPayload())
							}
							disabled={testSmtp.isPending}
						>
							{testSmtp.isPending ? "Sending…" : "Test send"}
						</PvButton>
						<TestResult result={smtpResult} />
					</div>
				</div>
			)}

			{/* Reading (IMAP) */}
			<PvCheckbox
				checked={form.read_enabled}
				onChange={setBool("read_enabled")}
				label="Enable reading (IMAP)"
			/>
			{form.read_enabled && (
				<div className="vp-email-section">
					<div className="vp-row" style={{ gap: 12, flexWrap: "wrap" }}>
						<div
							className="vp-field"
							style={{ flex: "2 1 220px", marginBottom: 0 }}
						>
							<span className="vp-label">IMAP Host</span>
							<input
								className="vp-input"
								type="text"
								spellCheck={false}
								placeholder="imap.gmail.com"
								value={form.imap_host}
								onChange={set("imap_host")}
							/>
						</div>
						<div
							className="vp-field"
							style={{ flex: "0 1 100px", marginBottom: 0 }}
						>
							<span className="vp-label">Port</span>
							<input
								className="vp-input"
								type="number"
								value={form.imap_port}
								onChange={set("imap_port")}
							/>
						</div>
						<div
							className="vp-field"
							style={{ flex: "1 1 160px", marginBottom: 0 }}
						>
							<span className="vp-label">Security</span>
							<select
								className="vp-input"
								value={form.imap_security}
								onChange={set("imap_security")}
							>
								{SECURITY_OPTS.map((o) => (
									<option key={o.id} value={o.id}>
										{o.label}
									</option>
								))}
							</select>
						</div>
					</div>
					<div className="vp-row" style={{ gap: 12, flexWrap: "wrap" }}>
						<div
							className="vp-field"
							style={{ flex: "1 1 220px", marginBottom: 0 }}
						>
							<span className="vp-label">Username</span>
							<input
								className="vp-input"
								type="text"
								spellCheck={false}
								autoComplete="off"
								placeholder="defaults to the email address"
								value={form.imap_username}
								onChange={set("imap_username")}
							/>
						</div>
						<div
							className="vp-field"
							style={{ flex: "1 1 220px", marginBottom: 0 }}
						>
							<span className="vp-label">
								Password / App password{" "}
								{!isNew && <Chip on={account.imap_password_set} />}
							</span>
							<input
								className="vp-input"
								type="password"
								autoComplete="new-password"
								placeholder={
									!isNew && account.imap_password_set
										? "•••• configured — leave blank to keep"
										: "app password"
								}
								value={form.imap_password}
								onChange={set("imap_password")}
							/>
						</div>
					</div>
					<div className="vp-svc-test">
						<PvButton
							size="sm"
							onClick={() =>
								runTest(testImap, setImapResult, imapTestPayload())
							}
							disabled={testImap.isPending}
						>
							{testImap.isPending ? "Connecting…" : "Test login"}
						</PvButton>
						<TestResult result={imapResult} />
					</div>
				</div>
			)}

			{/* System sender — only sending accounts qualify. */}
			{form.send_enabled && (
				<PvCheckbox
					className="vp-email-toggle"
					checked={form.is_default}
					onChange={setBool("is_default")}
					label="Use as system sender (verification & password-reset email)"
				/>
			)}

			<div className="vp-row" style={{ gap: 8, marginTop: 12 }}>
				<PvButton variant="primary" onClick={handleSave} disabled={busy}>
					{busy ? "Saving…" : isNew ? "Add account" : "Save"}
				</PvButton>
				{isNew ? (
					<PvButton size="sm" onClick={onCancelDraft}>
						Cancel
					</PvButton>
				) : (
					<>
						{!account.is_default && account.send_enabled && (
							<PvButton
								size="sm"
								onClick={handleSetDefault}
								disabled={setDefault.isPending}
							>
								Make system sender
							</PvButton>
						)}
						<PvButton
							size="sm"
							variant="danger"
							onClick={() => onDeleteRequest(account)}
						>
							Delete
						</PvButton>
					</>
				)}
			</div>
		</div>
	);
};

const EmailAccounts = () => {
	const { data: accounts = [], isLoading, error } = useEmailAccounts();
	const del = useDeleteEmailAccount();
	const [draft, setDraft] = useState(false);
	const [pendingDelete, setPendingDelete] = useState(null);

	const confirmDelete = async () => {
		if (!pendingDelete) return;
		const acct = pendingDelete;
		setPendingDelete(null);
		try {
			await del.mutateAsync(acct.id);
			pvMessage.success("Account deleted");
		} catch (err) {
			pvMessage.error(err?.response?.data?.error || "Failed to delete");
		}
	};

	return (
		<PvPanel title="email · accounts">
			<p className="vp-card-desc" style={{ marginBottom: 16 }}>
				Add one or more mailboxes. Each can independently send (SMTP) and/or
				read (IMAP). One sending account is the <strong>system sender</strong>{" "}
				used for verification &amp; password-reset email. Credentials are
				encrypted at rest.
			</p>
			<p
				className="vp-muted vp-text"
				style={{ fontSize: 12, marginBottom: 16 }}
			>
				Gmail / Yahoo / Fastmail need an <strong>app password</strong> (enable
				2-step verification first). Outlook/Microsoft 365 now requires OAuth2
				(not yet supported). Proton needs Proton Bridge. Custom-domain mailboxes
				use plain host/port/user/password.
			</p>

			{isLoading && <p className="vp-muted vp-text">Loading…</p>}
			{error && (
				<p className="vp-text" style={{ color: "var(--vp-accent-3)" }}>
					Failed to load email accounts.
				</p>
			)}

			<div className="vp-stack">
				{accounts.map((a) => (
					<AccountCard
						key={a.id}
						account={a}
						onDeleteRequest={setPendingDelete}
					/>
				))}
				{draft && (
					<AccountCard
						account={null}
						onCancelDraft={() => setDraft(false)}
						onDeleteRequest={setPendingDelete}
					/>
				)}
			</div>

			{!draft && (
				<div className="vp-row" style={{ marginTop: 16 }}>
					<PvButton onClick={() => setDraft(true)}>
						＋ Add account
					</PvButton>
				</div>
			)}

			<PvModal
				open={!!pendingDelete}
				title="Delete email account?"
				danger
				confirmText="Delete"
				cancelText="Cancel"
				onConfirm={confirmDelete}
				onCancel={() => setPendingDelete(null)}
			>
				<p className="vp-text">
					This permanently removes <strong>{pendingDelete?.label}</strong> and
					its stored credentials. This cannot be undone.
				</p>
			</PvModal>
		</PvPanel>
	);
};

export default EmailAccounts;
