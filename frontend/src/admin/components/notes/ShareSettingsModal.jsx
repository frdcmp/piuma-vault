import { useEffect, useState } from "react";
import { PvModal, pvMessage } from "@/admin/components/ui";
import useShareDefaultsStore, {
	SHARE_DEFAULTS,
	SHARE_EXPIRY_OPTIONS,
} from "../../../store/shareDefaultsStore";

/**
 * Editor for the browser-local defaults used when creating note share links.
 * Opened from the gear icon in SharePopover; saves to localStorage via
 * shareDefaultsStore. Changes apply to links created from now on — existing
 * links are untouched.
 */
export default function ShareSettingsModal({ open, onClose }) {
	const defaults = useShareDefaultsStore((s) => s.defaults);
	const setShareDefaults = useShareDefaultsStore((s) => s.setShareDefaults);
	const resetShareDefaults = useShareDefaultsStore((s) => s.resetShareDefaults);

	// Local draft so Cancel/ESC discards edits.
	const [draft, setDraft] = useState(defaults);

	useEffect(() => {
		if (open) setDraft(defaults);
	}, [open, defaults]);

	const patch = (fields) => setDraft((d) => ({ ...d, ...fields }));

	const handleSave = () => {
		setShareDefaults(draft);
		pvMessage.success("Share defaults saved");
		onClose?.();
	};

	const handleReset = () => {
		resetShareDefaults();
		setDraft({ ...SHARE_DEFAULTS });
		pvMessage.info("Share defaults reset");
	};

	return (
		<PvModal
			open={open}
			title="Share link defaults"
			confirmText="Save defaults"
			onConfirm={handleSave}
			onCancel={onClose}
			showClose
		>
			<p
				style={{
					margin: "0 0 14px 0",
					fontSize: 12,
					color: "var(--vp-muted, var(--muted))",
				}}
			>
				Pre-fills the share form every time you open it. Stored in this browser
				only.
			</p>

			<div className="vp-field">
				<label className="vp-label" htmlFor="share-def-access">
					Default access
				</label>
				<select
					id="share-def-access"
					className="vp-select"
					value={draft.accessLevel}
					onChange={(e) => patch({ accessLevel: e.target.value })}
				>
					<option value="view">View</option>
					<option value="edit">Edit</option>
				</select>
			</div>

			<div className="vp-field">
				<div className="pixel-switch-row">
					<label className="vp-label" htmlFor="share-def-pwd-toggle">
						Require password by default
					</label>
					<button
						id="share-def-pwd-toggle"
						type="button"
						className={`pixel-switch${draft.passwordEnabled ? " on" : ""}`}
						role="switch"
						aria-checked={draft.passwordEnabled}
						onClick={() => patch({ passwordEnabled: !draft.passwordEnabled })}
					/>
				</div>
				<input
					className="vp-input"
					type="text"
					autoComplete="off"
					placeholder="Default password (optional)"
					value={draft.defaultPassword}
					onChange={(e) => patch({ defaultPassword: e.target.value })}
				/>
			</div>

			<div className="vp-field">
				<div className="pixel-switch-row">
					<label className="vp-label" htmlFor="share-def-exp-toggle">
						Expire links by default
					</label>
					<button
						id="share-def-exp-toggle"
						type="button"
						className={`pixel-switch${draft.expireEnabled ? " on" : ""}`}
						role="switch"
						aria-checked={draft.expireEnabled}
						onClick={() => patch({ expireEnabled: !draft.expireEnabled })}
					/>
				</div>
				<select
					className="vp-select"
					value={draft.expiresInHours}
					disabled={!draft.expireEnabled}
					onChange={(e) => patch({ expiresInHours: e.target.value })}
					aria-label="Default expiry"
				>
					{SHARE_EXPIRY_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			</div>

			<div className="vp-field">
				<label className="vp-label" htmlFor="share-def-copy">
					Copy on link creation
				</label>
				<select
					id="share-def-copy"
					className="vp-select"
					value={draft.autoCopy}
					onChange={(e) => patch({ autoCopy: e.target.value })}
				>
					<option value="view">Share link (human view)</option>
					<option value="llm">LLM/AI URL (markdown API)</option>
					<option value="none">Nothing — don't copy</option>
				</select>
			</div>

			<button type="button" className="vp-btn vp-btn--sm" onClick={handleReset}>
				Reset to defaults
			</button>
		</PvModal>
	);
}
