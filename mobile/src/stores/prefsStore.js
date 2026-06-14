import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

// Small bag of non-sensitive UI preferences persisted to AsyncStorage so they
// survive app restarts (unlike component state). Hydrates once at module load;
// writes are fire-and-forget. Add more prefs here as needed.

const CALENDAR_VIEW_KEY = "pref_calendar_view";
const CALENDAR_VIEWS = ["month", "week", "3day"];

const MENU_STYLE_KEY = "pref_home_menu";
const MENU_STYLES = ["classic", "orbital", "dial", "fan", "constellation"];

export const usePrefsStore = create((set) => ({
	calendarView: "month",
	menuStyle: "classic",

	hydrate: async () => {
		try {
			const [view, menu] = await Promise.all([
				AsyncStorage.getItem(CALENDAR_VIEW_KEY),
				AsyncStorage.getItem(MENU_STYLE_KEY),
			]);
			if (CALENDAR_VIEWS.includes(view)) set({ calendarView: view });
			if (MENU_STYLES.includes(menu)) set({ menuStyle: menu });
		} catch {
			/* keep the defaults */
		}
	},

	setCalendarView: (view) => {
		set({ calendarView: view });
		AsyncStorage.setItem(CALENDAR_VIEW_KEY, view).catch(() => {});
	},

	setMenuStyle: (style) => {
		set({ menuStyle: style });
		AsyncStorage.setItem(MENU_STYLE_KEY, style).catch(() => {});
	},
}));

// Load the saved value as soon as the store is first imported.
usePrefsStore.getState().hydrate();
