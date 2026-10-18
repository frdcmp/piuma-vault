import { useState } from "react";
import { PvButton, PvField, PvInput, PvModal, PvSelect, pvMessage } from "@/ui";
import {
	useCreateFolderShare,
	useDeleteFolderShare,
	useFolderShares,
	useUpdateFolderShare,
} from "../../../queries";
import { formatDateTime } from "../../../utils/dateTime";

const EXPIRY_OPTIONS = [
	{ label: "Never", hours: null },
	{ label: "1 hour", hours: 1 },
	{ label: "1 day", hours: 24 },
	{ label: "7 days", hours: 24 * 7 },
	{ label: "30 days", hours: 24 * 30 },
];

const ACCESS_OPTIONS = [
	{ value: "view", label: "View only (browse + download)" },
	{ value: "edit", label: "Edit (upload, delete, create folders)" },
];
const EXPIRY_SELECT = EXPIRY_OPTIONS.map((o, i) => ({
	value: i,
	label: o.label,
}));

const fullUrl = (relUrl) => {
	if (!relUrl) return "";
	if (/^https?:\/\//.test(relUrl)) return relUrl;
	return `${window.location.origin}${relUrl.startsWith("/") ? "" : "/"}${relUrl}`;
};

/**
 * Admin dialog to create / manage public shares for a single storage folder.
 * `prefix` is the folder key (trailing slash). Shows the create form plus a list
 * of existing shares for this folder with copy / toggle / revoke.
 */
export default function FolderShareModal({ open, prefix, onClose }) {
	const shares = useFolderShares(prefix, { enabled: open && !!prefix });
	const createShare = useCreateFolderShare();
	const updateShare = useUpdateFolderShare();
	const deleteShare = useDeleteFolderShare();

	const [accessLevel, setAccessLevel] = useState("edit");
	const [password, setPassword] = useState("");
	const [expiryIdx, setExpiryIdx] = useState(0);

	const list = shares.data || [];

	const handleCreate = async () => {
		try {
			await createShare.mutateAsync({
				prefix,
				accessLevel,
				password: password || undefined,
				expiresInHours: EXPIRY_OPTIONS[expiryIdx].hours,
			});
			setPassword("");
			pvMessage.success("Share link created");
		} catch (e) {
			pvMessage.error(
				`Create failed: ${e?.response?.data?.error || e.message}`,
			);
		}
	};

	const copyUrl = async (relUrl) => {
		try {
			await navigator.clipboard.writeText(fullUrl(relUrl));
			pvMessage.success("Link copied");
		} catch {
			pvMessage.error("Could not copy");
		}
	};

	const toggleActive = (s) =>
		updateShare.mutate({ id: s.id, is_active: !s.is_active });

	const revoke = (s) =>
		deleteShare.mutate(s.id, {
			onSuccess: () => pvMessage.success("Share revoked"),
		});

	return (
		<PvModal
			open={open}
			title={`Share folder · ${prefix || "/"}`}
			showClose
			onCancel={onClose}
		>
			{/* Create form */}
			<div className="fshare-form">
				<PvField label="Access">
					<PvSelect
						options={ACCESS_OPTIONS}
						value={accessLevel}
						onChange={setAccessLevel}
					/>
				</PvField>

				<PvField
					label={
						<>
							Password{" "}
							<span className="fshare-hint">
								{accessLevel === "edit"
									? "(recommended for edit links)"
									: "(optional)"}
							</span>
						</>
					}
				>
					<PvInput
						autoComplete="off"
						placeholder="leave empty for no password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</PvField>

				<PvField label="Expires">
					<PvSelect
						options={EXPIRY_SELECT}
						value={expiryIdx}
						onChange={setExpiryIdx}
					/>
				</PvField>

				<PvButton
					variant="primary"
					icon="🔗"
					onClick={handleCreate}
					disabled={createShare.isPending}
					loading={createShare.isPending}
				>
					Create share link
				</PvButton>
			</div>

			{/* Existing shares */}
			<div className="fshare-section-label">Existing links ({list.length})</div>
			{shares.isLoading ? (
				<div className="fshare-status">loading…</div>
			) : list.length === 0 ? (
				<div className="fshare-status fshare-status-empty">
					No share links for this folder yet.
				</div>
			) : (
				<div className="fshare-list">
					{list.map((s) => (
						<div
							key={s.id}
							className={`fshare-row ${s.is_active ? "" : "fshare-row--inactive"}`}
						>
							<div className="fshare-row-main">
								<span
									className={`fshare-badge fshare-badge--${s.access_level}`}
								>
									{s.access_level}
								</span>
								{s.has_password && (
									<span className="fshare-badge fshare-badge--pwd">🔒</span>
								)}
								<button
									type="button"
									className="fshare-url"
									onClick={() => copyUrl(s.url)}
									title="Copy link"
								>
									{fullUrl(s.url)}
								</button>
							</div>
							<div className="fshare-row-meta">
								<span>
									{s.expires_at
										? `expires ${formatDateTime(s.expires_at).date}`
										: "never expires"}
								</span>
								{!s.is_active && <span className="fshare-off">disabled</span>}
							</div>
							<div className="fshare-row-actions">
								<PvButton size="sm" onClick={() => copyUrl(s.url)}>
									Copy
								</PvButton>
								<PvButton size="sm" onClick={() => toggleActive(s)}>
									{s.is_active ? "Disable" : "Enable"}
								</PvButton>
								<PvButton size="sm" variant="danger" onClick={() => revoke(s)}>
									Revoke
								</PvButton>
							</div>
						</div>
					))}
				</div>
			)}
		</PvModal>
	);
}
