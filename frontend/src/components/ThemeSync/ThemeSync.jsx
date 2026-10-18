import { useEffect } from "react";
import { useAppearance } from "@/queries";
import { defaultTheme, themes, useTheme } from "@/theme";

/**
 * Applies the vault's saved theme (app_settings, via GET /settings/appearance)
 * once it loads. index.html already painted the last-used theme from
 * localStorage, so this only corrects it when another device changed it.
 */
export default function ThemeSync() {
	const { data } = useAppearance();
	const { theme, setTheme } = useTheme();
	const saved = data?.theme ?? defaultTheme;

	useEffect(() => {
		if (!data) return;
		if (!themes[saved]) {
			// A theme removed from tokens.json but still saved in the DB.
			console.warn(`saved theme "${saved}" is not in tokens.json`);
			return;
		}
		if (saved !== theme) setTheme(saved);
	}, [data, saved, theme, setTheme]);

	return null;
}
