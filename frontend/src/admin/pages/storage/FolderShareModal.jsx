import { useState } from "react";
import { PvModal, pvMessage } from "@/admin/components/ui";
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
				<div className="vp-field">
					<label className="vp-label" htmlFor="fshare-access">
						Access
					</label>
					<select
						id="fshare-access"
						className="vp-select"
						value={accessLevel}
						onChange={(e) => setAccessLevel(e.target.value)}
					>
						<option value="view">View only (browse + download)</option>
						<option value="edit">Edit (upload, delete, create folders)</option>
					</select>
				</div>

				<div className="vp-field">
					<label className="vp-label" htmlFor="fshare-pwd">
						Password{" "}
						<span className="fshare-hint">
							{accessLevel === "edit"
								? "(recommended for edit links)"
								: "(optional)"}
						</span>
					</label>
					<input
						id="fshare-pwd"
						className="vp-input"
						type="text"
						autoComplete="off"
						placeholder="leave empty for no password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</div>

				<div className="vp-field">
					<label className="vp-label" htmlFor="fshare-expiry">
						Expires
					</label>
					<select
						id="fshare-expiry"
						className="vp-select"
						value={expiryIdx}
						onChange={(e) => setExpiryIdx(Number(e.target.value))}
					>
						{EXPIRY_OPTIONS.map((o, i) => (
							<option key={o.label} value={i}>
								{o.label}
							</option>
						))}
					</select>
				</div>

				<button
					type="button"
					className="vp-btn vp-btn--primary"
					onClick={handleCreate}
					disabled={createShare.isPending}
				>
					🔗 Create share link
				</button>
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
								<button
									type="button"
									className="vp-btn vp-btn--sm"
									onClick={() => copyUrl(s.url)}
								>
									Copy
								</button>
								<button
									type="button"
									className="vp-btn vp-btn--sm"
									onClick={() => toggleActive(s)}
								>
									{s.is_active ? "Disable" : "Enable"}
								</button>
								<button
									type="button"
									className="vp-btn vp-btn--sm vp-btn--danger"
									onClick={() => revoke(s)}
								>
									Revoke
								</button>
							</div>
						</div>
					))}
				</div>
			)}
		</PvModal>
	);
}
