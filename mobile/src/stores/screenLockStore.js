import { create } from "zustand";

// In-memory lock state. The ScreenLockGate flips this on cold start, on idle
// timeout, and when the app returns from the background past the timeout.
export const useScreenLockStore = create((set) => ({
	locked: false,
	lock: () => set({ locked: true }),
	unlock: () => set({ locked: false }),
}));
