import { useCallback, useEffect, useRef, useState } from "react";
import {
	PvButton,
	PvField,
	PvIconButton,
	PvInput,
	PvSelect,
	PvSwitch,
	PvTag,
	pvMessage,
} from "@/ui";
import {
	createShareLink,
	listShareLinks,
	revokeShareLink,
} from "../../../api/shares";
import useShareDefaultsStore, {
	SHARE_EXPIRY_OPTIONS,
} from "../../../store/shareDefaultsStore";
import ShareSettingsModal from "./ShareSettingsModal";
import "./SharePopover.css";

const ACCESS_OPTIONS = [
	{ value: "view", label: "View" },
	{ value: "edit", label: "Edit" },
];

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
	const passwordRef = useRef(null);

	// Focus the password field whenever it appears (popover opened with the
	// password default on, or the switch just turned on).
	useEffect(() => {
		if (open && passwordEnabled) passwordRef.current?.focus();
	}, [open, passwordEnabled]);

	// Stable per note, so the reset effect below still re-runs exactly on
	// open / note change / defaults change.
	const loadShares = useCallback(async () => {
		if (!noteId) return;
		try {
			const data = await listShareLinks(noteId);
			setShares(data);
		} catch {
			// Silently fail
		}
	}, [noteId]);

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
	}, [open, defaults, loadShares]);

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
		} catch {
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
		<div className="share-pop" ref={popoverRef}>
			{isMobile || iconOnly ? (
				<PvIconButton
					icon="🔗"
					label="Share this note"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
				/>
			) : (
				<PvButton
					size="sm"
					icon="🔗"
					onClick={() => setOpen(!open)}
					title="Share this note"
					aria-expanded={open}
				>
					Share
				</PvButton>
			)}

			{open && (
				<div className="share-pop-panel">
					<div className="share-pop-head">
						<h3 className="share-pop-title">Share this note</h3>
						<PvIconButton
							size="sm"
							variant="ghost"
							icon="⚙️"
							label="Share link defaults"
							onClick={() => setSettingsOpen(true)}
						/>
					</div>

					<PvField label="Access">
						<PvSelect
							size="sm"
							options={ACCESS_OPTIONS}
							value={accessLevel}
							onChange={setAccessLevel}
						/>
					</PvField>

					<div className="share-pop-group">
						<PvSwitch
							size="sm"
							label="Password"
							checked={passwordEnabled}
							aria-label="Require password"
							onChange={(next) => {
								setPasswordEnabled(next);
								if (!next) setPassword("");
								else if (!password) setPassword(defaults.defaultPassword);
							}}
						/>
						{passwordEnabled && (
							<PvInput
								ref={passwordRef}
								size="sm"
								type="password"
								placeholder="Enter password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
							/>
						)}
					</div>

					<div className="share-pop-group">
						<PvSwitch
							size="sm"
							label="Expires"
							checked={expireEnabled}
							aria-label="Set expiry"
							onChange={(next) => {
								setExpireEnabled(next);
								if (!next) setExpiresIn("");
								else if (!expiresIn) setExpiresIn(defaults.expiresInHours);
							}}
						/>
						{expireEnabled && (
							<PvSelect
								size="sm"
								options={SHARE_EXPIRY_OPTIONS}
								value={expiresIn || "1"}
								onChange={setExpiresIn}
								aria-label="Expiry"
							/>
						)}
					</div>

					<PvButton
						variant="primary"
						block
						loading={loading}
						disabled={loading}
						onClick={handleGenerate}
					>
						Generate Link
					</PvButton>

					{shares.length > 0 && (
						<div className="share-pop-shares">
							<strong className="share-pop-shares-title">Active shares:</strong>
							<div className="share-pop-list">
								{shares.map((share) => (
									<div key={share.id} className="share-pop-row">
										<PvTag
											color={
												share.access_level === "edit"
													? "var(--vp-danger)"
													: "var(--vp-info)"
											}
										>
											{share.access_level}
										</PvTag>
										<code className="share-pop-slug">{share.slug}</code>
										{share.has_password ? (
											<PvIconButton
												size="sm"
												variant="ghost"
												icon="🔒"
												label={
													sharePassword(share)
														? `Password: ${sharePassword(share)} — click to copy`
														: "Password-protected"
												}
												onClick={() => handleCopyPwd(share)}
											/>
										) : (
											<span className="share-pop-lock">🔓</span>
										)}
										<span className="share-pop-expiry">
											{formatExpiry(share.expires_at)}
										</span>
										<PvIconButton
											size="sm"
											icon={copiedSlug === share.slug ? "✓" : "📋"}
											label="Copy share link"
											onClick={() => handleCopy(share)}
										/>
										<PvIconButton
											size="sm"
											icon={copiedAiSlug === share.slug ? "✓" : "🤖"}
											label="Copy LLM/AI URL (markdown API)"
											onClick={() => handleCopyLlm(share)}
										/>
										<PvIconButton
											size="sm"
											variant="danger"
											icon="×"
											label="Revoke share link"
											onClick={() => handleRevoke(share.id)}
										/>
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
