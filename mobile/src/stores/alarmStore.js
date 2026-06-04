import { create } from "zustand";

// Holds the currently-ringing in-app alarm plus a small queue for alarms that
// arrive while one is already on screen. The AlarmModal subscribes to this; the
// notification listeners in App.js push into it. `present()` de-dupes by tag so
// a local + remote delivery of the same alert doesn't ring twice.
export const useAlarmStore = create((set, get) => ({
	active: null, // { tag, title, body, fireAt }
	queue: [],

	present(alarm) {
		const { active, queue } = get();
		const tag = alarm.tag;
		if (active?.tag === tag) return;
		if (tag && queue.some((a) => a.tag === tag)) return;
		if (active) set({ queue: [...queue, alarm] });
		else set({ active: alarm });
	},

	// Advance to the next queued alarm (or clear). Used by Dismiss/Snooze.
	dismiss() {
		const { queue } = get();
		if (queue.length) set({ active: queue[0], queue: queue.slice(1) });
		else set({ active: null });
	},
}));
