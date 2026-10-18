import { create } from "zustand";
import { defaultTheme, themes } from "./tokens.js";

// The active theme lives on <html data-theme="…">, which tokens.css keys its
// --vp-* variables on. JS consumers (canvas, three, recharts, mermaid) read the
// same values through useTheme().tokens.
export function applyTheme(id) {
	if (!themes[id]) throw new Error(`unknown theme "${id}"`);
	document.documentElement.dataset.theme = id;
}

// The active theme's tokens outside React (e.g. mermaid's one-off initialise).
export function currentTokens() {
	return themes[document.documentElement.dataset.theme ?? defaultTheme].tokens;
}

const useThemeStore = create((set) => ({
	theme: defaultTheme,
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
