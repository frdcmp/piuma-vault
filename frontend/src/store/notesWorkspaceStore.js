import { create } from "zustand";

// Single source of truth for the desktop notes workspace:
//   • tabs          — the notes the user has open (id, title, path)
//   • lockedContext — notes pinned into the chat context ("locked in"),
//                     which persist even after their tab is closed.
//
// The chat context chips are DERIVED from these two: every open tab shows a
// transient (unselected) chip; clicking it locks the note in; locked notes
// show a solid chip and survive tab close. See ChatPanel for the derivation.
//
// Replaces the old noteTabsStore + noteContextStore. The editor-toolbar bridge
// (noteControlsStore) stays separate — different lifecycle, no shared data.
const TABS_KEY = "piuma:notes-open-tabs";
const LOCK_KEY = "piuma:notes-locked-context";

const loadList = (key) => {
	try {
		const parsed = JSON.parse(localStorage.getItem(key));
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((t) => t && typeof t.id === "string")
			.map((t) => ({
				id: t.id,
				title: t.title || "Untitled",
				path: t.path || null,
				// preview = transient/italic tab (VSCode-style). Only tabs use this;
				// it's harmless (and ignored) on the locked-context list.
				preview: !!t.preview,
			}));
	} catch {
		return [];
	}
};

const persist = (key, list) => {
	try {
		localStorage.setItem(key, JSON.stringify(list));
	} catch {
		/* localStorage unavailable */
	}
};

// Merge fresh fields onto a matching entry without dropping known ones. Only
// the fields actually provided are overwritten — passing `preview: undefined`
// (the common case for a plain label refresh) leaves the tab's open-state alone.
const patchEntry = (entry, { title, path, preview } = {}) => ({
	...entry,
	...(title ? { title } : {}),
	...(path ? { path } : {}),
	...(preview !== undefined ? { preview } : {}),
});

const useNotesWorkspaceStore = create((set) => ({
	tabs: loadList(TABS_KEY),
	lockedContext: loadList(LOCK_KEY),

	// Open a tab (or refresh its title/path if already open). Also keeps any
	// locked copy of the same note in sync so its chip label stays current.
	//
	// A brand-new tab opens in PREVIEW (transient/italic) mode by default — this
	// is the single-click path. Because only one preview tab may exist at a time,
	// creating a new preview tab first evicts the previous one (VSCode behaviour).
	// Pass `preview: false` to open straight into a permanent tab instead.
	// Refreshing an existing tab never changes its open-state (preview omitted).
	openTab: (id, { title, path, preview } = {}) =>
		set((state) => {
			if (!id) return state;
			const existing = state.tabs.find((t) => t.id === id);
			let tabs;
			if (existing) {
				tabs = state.tabs.map((t) =>
					t.id === id ? patchEntry(t, { title, path, preview }) : t,
				);
			} else {
				const isPreview = preview !== false;
				const newTab = {
					id,
					title: title || "Untitled",
					path: path || null,
					preview: isPreview,
				};
				// Evict the outgoing preview tab only when this one is itself a
				// preview; a permanent open leaves any existing preview tab intact.
				const base = isPreview
					? state.tabs.filter((t) => !t.preview)
					: state.tabs;
				tabs = [...base, newTab];
			}
			persist(TABS_KEY, tabs);

			const lockedContext = state.lockedContext.map((t) =>
				t.id === id ? patchEntry(t, { title, path }) : t,
			);
			persist(LOCK_KEY, lockedContext);

			return { tabs, lockedContext };
		}),

	// Promote a tab to permanent (drop its italic/preview state), or create it
	// already-permanent if it isn't open yet. Triggered by double-clicking a file
	// in the explorer, double-clicking the tab, or editing the note. No-op once
	// the tab is already permanent, so it's cheap to call on every keystroke.
	pinTab: (id, { title, path } = {}) =>
		set((state) => {
			if (!id) return state;
			const existing = state.tabs.find((t) => t.id === id);
			if (existing && !existing.preview) return state;
			const tabs = existing
				? state.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t))
				: [
						...state.tabs,
						{
							id,
							title: title || "Untitled",
							path: path || null,
							preview: false,
						},
					];
			persist(TABS_KEY, tabs);
			return { tabs };
		}),

	closeTab: (id) =>
		set((state) => {
			const tabs = state.tabs.filter((t) => t.id !== id);
			persist(TABS_KEY, tabs);
			return { tabs };
		}),

	// Drag-to-sort: move the dragged tab so it lands at the target tab's slot,
	// shifting the rest along. No-op if either id is gone or they're the same.
	reorderTabs: (fromId, toId) =>
		set((state) => {
			if (!fromId || !toId || fromId === toId) return state;
			const from = state.tabs.findIndex((t) => t.id === fromId);
			const to = state.tabs.findIndex((t) => t.id === toId);
			if (from === -1 || to === -1) return state;
			const tabs = [...state.tabs];
			const [moved] = tabs.splice(from, 1);
			tabs.splice(to, 0, moved);
			persist(TABS_KEY, tabs);
			return { tabs };
		}),

	// Pin an open tab's note so it stays in chat context even after tab close.
	lockContext: (id) =>
		set((state) => {
			if (state.lockedContext.some((t) => t.id === id)) return state;
			const tab = state.tabs.find((t) => t.id === id);
			if (!tab) return state;
			const lockedContext = [...state.lockedContext, { ...tab }];
			persist(LOCK_KEY, lockedContext);
			return { lockedContext };
		}),

	unlockContext: (id) =>
		set((state) => {
			const lockedContext = state.lockedContext.filter((t) => t.id !== id);
			persist(LOCK_KEY, lockedContext);
			return { lockedContext };
		}),

	// Note deleted for good — drop it from both tabs and pinned context.
	removeNote: (id) =>
		set((state) => {
			const tabs = state.tabs.filter((t) => t.id !== id);
			const lockedContext = state.lockedContext.filter((t) => t.id !== id);
			persist(TABS_KEY, tabs);
			persist(LOCK_KEY, lockedContext);
			return { tabs, lockedContext };
		}),
}));

export default useNotesWorkspaceStore;
