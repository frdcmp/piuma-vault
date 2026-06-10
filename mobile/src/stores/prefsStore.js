import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

// Small bag of non-sensitive UI preferences persisted to AsyncStorage so they
// survive app restarts (unlike component state). Hydrates once at module load;
// writes are fire-and-forget. Add more prefs here as needed.

const CALENDAR_VIEW_KEY = "pref_calendar_view";
const CALENDAR_VIEWS = ["month", "week", "3day"];

export const usePrefsStore = create((set) => ({
	calendarView: "month",

	hydrate: async () => {
		try {
			const v = await AsyncStorage.getItem(CALENDAR_VIEW_KEY);
			if (CALENDAR_VIEWS.includes(v)) set({ calendarView: v });
		} catch {
			/* keep the default */
		}
	},

	setCalendarView: (view) => {
		set({ calendarView: view });
		AsyncStorage.setItem(CALENDAR_VIEW_KEY, view).catch(() => {});
	},
}));

// Load the saved value as soon as the store is first imported.
usePrefsStore.getState().hydrate();
