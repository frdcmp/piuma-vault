import { useEffect, useState } from "react";
import {
	PvButton,
	PvField,
	PvInput,
	PvModal,
	PvSelect,
	PvSwitch,
	pvMessage,
} from "@/ui";
import useShareDefaultsStore, {
	SHARE_DEFAULTS,
	SHARE_EXPIRY_OPTIONS,
} from "../../../store/shareDefaultsStore";
import "./SharePopover.css";

const ACCESS_OPTIONS = [
	{ value: "view", label: "View" },
	{ value: "edit", label: "Edit" },
];

const COPY_OPTIONS = [
	{ value: "view", label: "Share link (human view)" },
	{ value: "llm", label: "LLM/AI URL (markdown API)" },
	{ value: "none", label: "Nothing — don't copy" },
];

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
			<p className="share-settings-intro">
				Pre-fills the share form every time you open it. Stored in this browser
				only.
			</p>

			<PvField label="Default access">
				<PvSelect
					options={ACCESS_OPTIONS}
					value={draft.accessLevel}
					onChange={(v) => patch({ accessLevel: v })}
				/>
			</PvField>

			<PvField as="div">
				<PvSwitch
					size="sm"
					label="Require password by default"
					checked={draft.passwordEnabled}
					onChange={(v) => patch({ passwordEnabled: v })}
				/>
				<PvInput
					type="text"
					autoComplete="off"
					placeholder="Default password (optional)"
					value={draft.defaultPassword}
					onChange={(e) => patch({ defaultPassword: e.target.value })}
				/>
			</PvField>

			<PvField as="div">
				<PvSwitch
					size="sm"
					label="Expire links by default"
					checked={draft.expireEnabled}
					onChange={(v) => patch({ expireEnabled: v })}
				/>
				<PvSelect
					options={SHARE_EXPIRY_OPTIONS}
					value={draft.expiresInHours}
					disabled={!draft.expireEnabled}
					onChange={(v) => patch({ expiresInHours: v })}
					aria-label="Default expiry"
				/>
			</PvField>

			<PvField label="Copy on link creation">
				<PvSelect
					options={COPY_OPTIONS}
					value={draft.autoCopy}
					onChange={(v) => patch({ autoCopy: v })}
				/>
			</PvField>

			<PvButton size="sm" onClick={handleReset}>
				Reset to defaults
			</PvButton>
		</PvModal>
	);
}
