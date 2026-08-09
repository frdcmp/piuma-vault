import { useEffect, useRef, useState } from "react";
import { pvMessage } from "@/admin/components/ui";
import {
	createShareLink,
	listShareLinks,
	revokeShareLink,
} from "../../../api/shares";
import useShareDefaultsStore, {
	SHARE_EXPIRY_OPTIONS,
} from "../../../store/shareDefaultsStore";
import ShareSettingsModal from "./ShareSettingsModal";

export default function SharePopover({ noteId, isMobile, iconOnly }) {
	const [open, setOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [shares, setShares] = useState([]);
	const [lastPassword, setLastPassword] = useState(null);
	const [copiedSlug, setCopiedSlug] = useState(null);
	const [copiedAiSlug, setCopiedAiSlug] = useState(null);

	// Browser-local defaults (gear icon) seed the form on every open.
	const defaults = useShareDefaultsStore((s) => s.defaults);

	const [accessLevel, setAccessLevel] = useState(defaults.accessLevel);
	const [password, setPassword] = useState("");
	const [expiresIn, setExpiresIn] = useState(defaults.expiresInHours);
	const [passwordEnabled, setPasswordEnabled] = useState(
		defaults.passwordEnabled,
	);
	const [expireEnabled, setExpireEnabled] = useState(defaults.expireEnabled);

	const popoverRef = useRef(null);

	const loadShares = async () => {
		if (!noteId) return;
		try {
			const data = await listShareLinks(noteId);
			setShares(data);
		} catch {
			// Silently fail
		}
	};

	useEffect(() => {
		if (open) {
			setLastPassword(null);
			setCopiedSlug(null);
			setCopiedAiSlug(null);
			setAccessLevel(defaults.accessLevel);
			setPassword(defaults.passwordEnabled ? defaults.defaultPassword : "");
			setExpiresIn(defaults.expiresInHours);
			setPasswordEnabled(defaults.passwordEnabled);
			setExpireEnabled(defaults.expireEnabled);
			loadShares();
		}
	}, [open, noteId, defaults]);

	useEffect(() => {
		// The settings modal renders in a portal outside this subtree, so clicks
		// inside it must not be treated as "outside" and close the popover.
		if (settingsOpen) return;
		const handleClickOutside = (event) => {
			if (popoverRef.current && !popoverRef.current.contains(event.target)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [settingsOpen]);

	const handleGenerate = async () => {
		try {
			setLoading(true);
			const effectivePassword = passwordEnabled ? password || null : null;
			const effectiveExpiry =
				expireEnabled && expiresIn ? parseInt(expiresIn, 10) : null;
			const created = await createShareLink(noteId, {
				accessLevel,
				password: effectivePassword,
				expiresInHours: effectiveExpiry,
			});

			setLastPassword(effectivePassword);
			await loadShares();

			// What lands on the clipboard is a user preference (gear icon):
			// the human-facing link stays bare — the share page prompts for the
			// password — while the LLM/API URL embeds ?pwd= since it can't prompt.
			const wantsLlm = defaults.autoCopy === "llm";
			const url = !created?.slug
				? ""
				: wantsLlm
					? buildLlmUrl({
							...created,
							has_password: !!effectivePassword,
							// state hasn't flushed yet, so pass the password explicitly
							password: effectivePassword,
						})
					: `${window.location.origin}/share/v/${created.slug}`;

			let copied = false;
			if (url && defaults.autoCopy !== "none") {
				try {
					await navigator.clipboard.writeText(url);
					copied = true;
					const markCopied = wantsLlm ? setCopiedAiSlug : setCopiedSlug;
					markCopied(created.slug);
					setTimeout(() => markCopied(null), 2000);
				} catch {
					// fall through to non-copied notice
				}
			}

			if (copied) {
				pvMessage.success(
					wantsLlm ? "LLM URL copied to clipboard" : "Link copied to clipboard",
				);
			} else {
				pvMessage.info("Share link created");
			}
		} catch (err) {
			pvMessage.error("Failed to create share link");
		} finally {
			setLoading(false);
		}
	};

	// Resolve the share's password: the server returns the decrypted value
	// (owner-only) so the LLM URL works even for shares made in another session;
	// fall back to the just-generated password if the list hasn't reloaded yet.
	const sharePassword = (share) =>
		share?.has_password ? share.password || lastPassword || null : null;

	// Human-facing link is always bare — the public share page prompts the
	// visitor for the password, so we never leak it in the URL/history.
	const buildShareUrl = (share) =>
		share?.slug ? `${window.location.origin}/share/v/${share.slug}` : "";

	const buildLlmUrl = (share) => {
		if (!share?.slug) return "";
		const apiBase = `${import.meta.env.BASE_URL || "/"}api/v1`;
		const base = `${window.location.origin}${apiBase}/share/v/${share.slug}`;
		const pwd = sharePassword(share);
		return pwd ? `${base}?pwd=${encodeURIComponent(pwd)}` : base;
	};

	const handleCopy = async (share) => {
		const url = buildShareUrl(share);
		try {
			await navigator.clipboard.writeText(url);
			setCopiedSlug(share.slug);
			setTimeout(() => setCopiedSlug(null), 2000);
			pvMessage.success("Share link copied");
		} catch {
			pvMessage.error("Failed to copy");
		}
	};

	const handleCopyLlm = async (share) => {
		const url = buildLlmUrl(share);
		try {
			await navigator.clipboard.writeText(url);
			setCopiedAiSlug(share.slug);
			setTimeout(() => setCopiedAiSlug(null), 2000);
			pvMessage.success("LLM URL copied");
		} catch {
			pvMessage.error("Failed to copy");
		}
	};

	const handleCopyPwd = async (share) => {
		const pwd = sharePassword(share);
		if (!pwd) return;
		try {
			await navigator.clipboard.writeText(pwd);
			pvMessage.success("Password copied");
		} catch {
			pvMessage.error("Failed to copy");
		}
	};

	const handleRevoke = async (shareId) => {
		try {
			await revokeShareLink(shareId);
			await loadShares();
			pvMessage.info("Share link revoked");
		} catch {
			pvMessage.error("Failed to revoke share link");
		}
	};

	const formatExpiry = (expiresAt) => {
		if (!expiresAt) return "Never";
		const date = new Date(expiresAt);
		const now = new Date();
		const diffMs = date - now;
		if (diffMs < 0) return "Expired";
		const diffHours = Math.round(diffMs / (1000 * 60 * 60));
		if (diffHours < 1) return "< 1h";
		if (diffHours < 24) return `${diffHours}h`;
		const diffDays = Math.round(diffHours / 24);
		return `${diffDays}d`;
	};

	return (
		<div style={{ position: "relative" }} ref={popoverRef}>
			<button
				type="button"
				className={`pixel-btn ${isMobile || iconOnly ? "icon-only" : ""}`}
				onClick={() => setOpen(!open)}
				title="Share this note"
			>
				🔗 {isMobile || iconOnly ? "" : "Share"}
			</button>

			{open && (
				<div
					className="pixel-modal"
					style={{
						position: "absolute",
						right: 0,
						top: "100%",
						marginTop: 8,
						zIndex: 100,
						width: 320,
						boxShadow: "4px 4px 0 0 #000",
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							margin: "0 0 12px 0",
						}}
					>
						<h3 style={{ margin: 0, color: "var(--accent)" }}>
							Share this note
						</h3>
						<button
							type="button"
							className="pixel-btn icon-only"
							style={{ padding: "0 6px" }}
							onClick={() => setSettingsOpen(true)}
							title="Share link defaults"
							aria-label="Share link defaults"
						>
							⚙️
						</button>
					</div>

					<div style={{ marginBottom: 12 }}>
						<label style={{ display: "block", marginBottom: 4, fontSize: 12 }}>
							Access
						</label>
						<select
							className="pixel-input"
							value={accessLevel}
							onChange={(e) => setAccessLevel(e.target.value)}
						>
							<option value="view">View</option>
							<option value="edit">Edit</option>
						</select>
					</div>

					<div style={{ marginBottom: 12 }}>
						<div className="pixel-switch-row" style={{ marginBottom: 4 }}>
							<label style={{ fontSize: 12 }}>Password</label>
							<button
								type="button"
								className={`pixel-switch${passwordEnabled ? " on" : ""}`}
								role="switch"
								aria-checked={passwordEnabled}
								aria-label="Require password"
								onClick={() => {
									const next = !passwordEnabled;
									setPasswordEnabled(next);
									if (!next) setPassword("");
									else if (!password) setPassword(defaults.defaultPassword);
								}}
							/>
						</div>
						{passwordEnabled && (
							<input
								className="pixel-input"
								type="password"
								placeholder="Enter password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								autoFocus
							/>
						)}
					</div>

					<div style={{ marginBottom: 12 }}>
						<div className="pixel-switch-row" style={{ marginBottom: 4 }}>
							<label style={{ fontSize: 12 }}>Expires</label>
							<button
								type="button"
								className={`pixel-switch${expireEnabled ? " on" : ""}`}
								role="switch"
								aria-checked={expireEnabled}
								aria-label="Set expiry"
								onClick={() => {
									const next = !expireEnabled;
									setExpireEnabled(next);
									if (!next) setExpiresIn("");
									else if (!expiresIn) setExpiresIn(defaults.expiresInHours);
								}}
							/>
						</div>
						{expireEnabled && (
							<select
								className="pixel-input"
								value={expiresIn || "1"}
								onChange={(e) => setExpiresIn(e.target.value)}
							>
								{SHARE_EXPIRY_OPTIONS.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</select>
						)}
					</div>

					<button
						className="pixel-btn primary"
						style={{ width: "100%", justifyContent: "center" }}
						onClick={handleGenerate}
						disabled={loading}
					>
						{loading ? "..." : "Generate Link"}
					</button>

					{shares.length > 0 && (
						<div style={{ marginTop: 16 }}>
							<strong style={{ fontSize: 12, color: "var(--muted)" }}>
								Active shares:
							</strong>
							<div style={{ marginTop: 6, maxHeight: 160, overflowY: "auto" }}>
								{shares.map((share) => (
									<div
										key={share.id}
										style={{
											display: "flex",
											alignItems: "center",
											gap: 4,
											padding: "4px 0",
											borderBottom: `1px dashed var(--border-strong)`,
										}}
									>
										<span
											className="pixel-tag"
											style={{
												color:
													share.access_level === "edit"
														? "var(--accent-3)"
														: "var(--accent-4)",
											}}
										>
											{share.access_level}
										</span>
										<code
											style={{
												fontSize: 11,
												flex: 1,
												overflow: "hidden",
												textOverflow: "ellipsis",
											}}
										>
											{share.slug}
										</code>
										{share.has_password ? (
											<button
												type="button"
												onClick={() => handleCopyPwd(share)}
												title={
													sharePassword(share)
														? `Password: ${sharePassword(share)} — click to copy`
														: "Password-protected"
												}
												style={{
													background: "none",
													border: 0,
													padding: 0,
													fontSize: 12,
													cursor: "pointer",
												}}
											>
												🔒
											</button>
										) : (
											<span style={{ fontSize: 12 }}>🔓</span>
										)}
										<span
											style={{
												fontSize: 10,
												color: "var(--muted)",
												width: 40,
												textAlign: "right",
											}}
										>
											{formatExpiry(share.expires_at)}
										</span>
										<button
											className="pixel-btn icon-only"
											style={{ padding: "0 4px" }}
											onClick={() => handleCopy(share)}
											title="Copy share link"
										>
											{copiedSlug === share.slug ? "✓" : "📋"}
										</button>
										<button
											className="pixel-btn icon-only"
											style={{ padding: "0 4px" }}
											onClick={() => handleCopyLlm(share)}
											title="Copy LLM/AI URL (markdown API)"
										>
											{copiedAiSlug === share.slug ? "✓" : "🤖"}
										</button>
										<button
											className="pixel-btn danger icon-only"
											style={{ padding: "0 4px" }}
											onClick={() => handleRevoke(share.id)}
										>
											×
										</button>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			)}

			<ShareSettingsModal
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
			/>
		</div>
	);
}
