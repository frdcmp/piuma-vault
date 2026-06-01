import { create } from "zustand";

/**
 * Shared selection state for the storage explorer, so the folder tree and the
 * file grid stay in sync without prop-drilling or coordination hacks.
 *
 * Selection is a Set of ABSOLUTE keys — folder keys end in "/", file keys don't,
 * so they never collide. The current folder is intentionally NOT kept here: that
 * lives in the URL (`?path=`), the single source of truth for navigation and
 * breadcrumbs.
 */
export const useStorageWorkspace = create((set) => ({
	selection: new Set(),

	// Replace the whole selection (accepts any iterable of keys).
	setSelection: (keys) => set({ selection: new Set(keys) }),

	// Select exactly one item.
	selectOne: (key) => set({ selection: new Set([key]) }),

	// Add/remove one item (ctrl/⌘-click, checkbox).
	toggle: (key) =>
		set((s) => {
			const next = new Set(s.selection);
			next.has(key) ? next.delete(key) : next.add(key);
			return { selection: next };
		}),

	clearSelection: () =>
		set((s) => (s.selection.size ? { selection: new Set() } : s)),
}));

// Selector: the single selected FILE key (for the tree's highlight), else null.
// Returning a primitive means subscribers only re-render when it actually
// changes, not on every selection mutation.
export const selectSingleFileKey = (s) => {
	if (s.selection.size !== 1) return null;
	const [k] = s.selection;
	return k.endsWith("/") ? null : k;
};
