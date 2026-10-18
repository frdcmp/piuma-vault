import { create } from "zustand";
import { defaultTheme, themes } from "./tokens.js";

// The active theme lives on <html data-theme="…">, which tokens.css keys its
// --vp-* variables on. index.html sets it from localStorage before first paint;
// ThemeSync then applies the vault's saved theme from the API. JS consumers
// (canvas, three, recharts, mermaid) read the same values via useTheme().tokens.
export const THEME_STORAGE_KEY = "pv-theme";

export function applyTheme(id) {
	if (!themes[id]) throw new Error(`unknown theme "${id}"`);
	document.documentElement.dataset.theme = id;
	localStorage.setItem(THEME_STORAGE_KEY, id);
}

// The active theme's tokens outside React (e.g. mermaid's one-off initialise).
export function currentTokens() {
	return themes[document.documentElement.dataset.theme ?? defaultTheme].tokens;
}

const initial = themes[document.documentElement.dataset.theme]
	? document.documentElement.dataset.theme
	: defaultTheme;

const useThemeStore = create((set) => ({
	theme: initial,
	setTheme: (id) => {
		applyTheme(id);
		set({ theme: id });
	},
}));

export function useTheme() {
	const theme = useThemeStore((s) => s.theme);
	const setTheme = useThemeStore((s) => s.setTheme);
	return { theme, setTheme, tokens: themes[theme].tokens, themes };
}
