import { create } from "zustand";

// Runtime state for the idle screen lock. `locked` is persisted to localStorage
// so a page reload while locked stays locked instead of dropping the overlay.
// Idle/activity tracking lives in the gate component (a ref, to avoid re-renders).

const STORAGE_KEY = "vault.screenlock.locked";

const loadLocked = () => {
	try {
		return localStorage.getItem(STORAGE_KEY) === "true";
	} catch {
		return false;
	}
};

const persistLocked = (locked) => {
	try {
		if (locked) {
			localStorage.setItem(STORAGE_KEY, "true");
		} else {
			localStorage.removeItem(STORAGE_KEY);
		}
	} catch {
		/* localStorage may be unavailable */
	}
};

const useScreenLockStore = create((set) => ({
	locked: loadLocked(),
	lock: () => {
		persistLocked(true);
		set({ locked: true });
	},
	unlock: () => {
		persistLocked(false);
		set({ locked: false });
	},
}));

export default useScreenLockStore;
