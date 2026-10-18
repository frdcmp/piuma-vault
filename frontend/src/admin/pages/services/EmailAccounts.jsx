import { useState } from "react";
import {
	PvButton,
	PvCheckbox,
	PvField,
	PvInput,
	PvModal,
	PvPanel,
	PvSelect,
	pvMessage,
} from "@/ui";
import {
	useCreateEmailAccount,
	useDeleteEmailAccount,
	useEmailAccounts,
	useSetDefaultEmailAccount,
	useTestEmailImap,
	useTestEmailSmtp,
	useUpdateEmailAccount,
} from "../../../queries";

const SECURITY_OPTIONS = [
	{ value: "starttls", label: "STARTTLS (587)" },
	{ value: "ssl", label: "SSL/TLS (465 / 993)" },
	{ value: "none", label: "None (plaintext)" },
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
	const setVal = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
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

	// SMTP / IMAP block — same shape for both protocols.
	const serverFields = (proto, hostPh) => (
		<>
			<div className="vp-row vp-svc-fields">
				<PvField
					className="vp-svc-col vp-svc-col--host"
					label={`${proto.toUpperCase()} Host`}
				>
					<PvInput
						spellCheck={false}
						placeholder={hostPh}
						value={form[`${proto}_host`]}
						onChange={set(`${proto}_host`)}
					/>
				</PvField>
				<PvField className="vp-svc-col vp-svc-col--port" label="Port">
					<PvInput
						type="number"
						value={form[`${proto}_port`]}
						onChange={set(`${proto}_port`)}
					/>
				</PvField>
				<PvField className="vp-svc-col vp-svc-col--sec" label="Security">
					<PvSelect
						value={form[`${proto}_security`]}
						onChange={setVal(`${proto}_security`)}
						options={SECURITY_OPTIONS}
					/>
				</PvField>
			</div>
			<div className="vp-row vp-svc-fields">
				<PvField className="vp-svc-col vp-svc-col--half" label="Username">
					<PvInput
						spellCheck={false}
						autoComplete="off"
						placeholder="defaults to the email address"
						value={form[`${proto}_username`]}
						onChange={set(`${proto}_username`)}
					/>
				</PvField>
				<PvField
					className="vp-svc-col vp-svc-col--half"
					label={
						<>
							Password / App password{" "}
							{!isNew && <Chip on={account[`${proto}_password_set`]} />}
						</>
					}
				>
					<PvInput
						type="password"
						reveal
						autoComplete="new-password"
						placeholder={
							!isNew && account[`${proto}_password_set`]
								? "•••• configured — leave blank to keep"
								: "app password"
						}
						value={form[`${proto}_password`]}
						onChange={set(`${proto}_password`)}
					/>
				</PvField>
			</div>
		</>
	);

	return (
		<div className="vp-email-card">
			<div className="vp-row vp-svc-fields">
				<PvField className="vp-svc-col" label="Label">
					<PvInput
						placeholder="Personal Gmail"
						value={form.label}
						onChange={set("label")}
					/>
				</PvField>
				<PvField
					className="vp-svc-col vp-svc-col--wide"
					label={
						<>
							Email address{" "}
							{!isNew && account.is_default && (
								<span className="vp-tag vp-tag--green vp-svc-chip">
									system sender
								</span>
							)}
						</>
					}
				>
					<PvInput
						type="email"
						spellCheck={false}
						placeholder="you@example.com"
						value={form.email_address}
						onChange={set("email_address")}
					/>
				</PvField>
			</div>

			{/* Sending (SMTP) */}
			<PvCheckbox
				checked={form.send_enabled}
				onChange={setBool("send_enabled")}
				label="Enable sending (SMTP)"
			/>
			{form.send_enabled && (
				<div className="vp-email-section">
					{serverFields("smtp", "smtp.gmail.com")}
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
					{serverFields("imap", "imap.gmail.com")}
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

			<div className="vp-row vp-email-actions">
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
			<p className="vp-card-desc vp-svc-desc">
				Add one or more mailboxes. Each can independently send (SMTP) and/or
				read (IMAP). One sending account is the <strong>system sender</strong>{" "}
				used for verification &amp; password-reset email. Credentials are
				encrypted at rest.
			</p>
			<p className="vp-muted vp-text vp-svc-note">
				Gmail / Yahoo / Fastmail need an <strong>app password</strong> (enable
				2-step verification first). Outlook/Microsoft 365 now requires OAuth2
				(not yet supported). Proton needs Proton Bridge. Custom-domain mailboxes
				use plain host/port/user/password.
			</p>

			{isLoading && <p className="vp-muted vp-text">Loading…</p>}
			{error && (
				<p className="vp-text vp-svc-error">Failed to load email accounts.</p>
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
				<div className="vp-row vp-svc-add">
					<PvButton onClick={() => setDraft(true)}>＋ Add account</PvButton>
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
