import { create } from "zustand";

export const SCREEN_MODES = {
	DESKTOP: "Desktop",
	TABLET: "Tablet",
	PHONE: "Phone",
};

// Breakpoints
const BREAKPOINTS = {
	TABLET: 768,
	DESKTOP: 1024,
};

const getScreenMode = (width) => {
	if (width >= BREAKPOINTS.DESKTOP) return SCREEN_MODES.DESKTOP;
	if (width >= BREAKPOINTS.TABLET) return SCREEN_MODES.TABLET;
	return SCREEN_MODES.PHONE;
};

const useUiStore = create((set) => ({
	screenMode: getScreenMode(window.innerWidth),
	isMobile: window.innerWidth < BREAKPOINTS.TABLET,

	// Action to update screen mode based on width
	handleResize: () => {
		const width = window.innerWidth;
		const mode = getScreenMode(width);
		set({
			screenMode: mode,
			isMobile: mode === SCREEN_MODES.PHONE,
		});
	},
}));

export default useUiStore;
