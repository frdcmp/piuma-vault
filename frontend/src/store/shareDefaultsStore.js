import { create } from "zustand";

// User-level defaults for the "create share link" form (notes SharePopover).
// Browser-local only — these are personal conveniences, not server policy, so
// they live in localStorage and never leave the machine. The popover seeds its
// form from these every time it opens; the gear icon edits them.
const STORAGE_KEY = "piuma:share-defaults";

export const SHARE_EXPIRY_OPTIONS = [
	{ value: "1", label: "1 hour" },
	{ value: "24", label: "24 hours" },
	{ value: "72", label: "3 days" },
	{ value: "168", label: "7 days" },
	{ value: "720", label: "30 days" },
];

export const SHARE_DEFAULTS = {
	accessLevel: "view", // "view" | "edit"
	passwordEnabled: false,
	defaultPassword: "", // pre-filled when passwordEnabled
	expireEnabled: true,
	expiresInHours: "1", // one of SHARE_EXPIRY_OPTIONS values
	autoCopy: "view", // "view" | "llm" | "none" — what lands on the clipboard
};

// Ignore anything unexpected in storage: only known keys survive, and each one
// falls back to its default if the stored value isn't a legal choice.
const sanitize = (raw) => {
	const s = raw && typeof raw === "object" ? raw : {};
	const expiry = String(s.expiresInHours ?? "");
	return {
		accessLevel: s.accessLevel === "edit" ? "edit" : "view",
		passwordEnabled: !!s.passwordEnabled,
		defaultPassword:
			typeof s.defaultPassword === "string" ? s.defaultPassword : "",
		expireEnabled: s.expireEnabled !== false,
		expiresInHours: SHARE_EXPIRY_OPTIONS.some((o) => o.value === expiry)
			? expiry
			: SHARE_DEFAULTS.expiresInHours,
		autoCopy:
			s.autoCopy === "llm" || s.autoCopy === "none" ? s.autoCopy : "view",
	};
};

const load = () => {
	try {
		return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
	} catch {
		return { ...SHARE_DEFAULTS };
	}
};

const persist = (defaults) => {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
	} catch {
		/* localStorage unavailable — keep the in-memory value */
	}
};

const useShareDefaultsStore = create((set, get) => ({
	defaults: load(),

	// Partial update: pass only the fields that changed.
	setShareDefaults: (patch) => {
		const next = sanitize({ ...get().defaults, ...patch });
		persist(next);
		set({ defaults: next });
	},

	resetShareDefaults: () => {
		persist(SHARE_DEFAULTS);
		set({ defaults: { ...SHARE_DEFAULTS } });
	},
}));

export default useShareDefaultsStore;
