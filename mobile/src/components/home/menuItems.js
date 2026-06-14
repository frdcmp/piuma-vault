import { colors } from "../../utils/theme";

// Single source of truth for the home destinations. Every menu variant renders
// from this list so adding/removing a destination touches one place. `notes`
// and `chat` open the side drawers (not navigation); the rest navigate, and
// `logout` triggers the confirm dialog owned by the HomeMenu shell.
export function buildHomeItems({
	onFiles,
	onChat,
	onStorage,
	onTasks,
	onCalendar,
	onRecorder,
	onSettings,
	onLogout,
}) {
	return [
		{
			key: "notes",
			label: "notes",
			glyph: "▥",
			tone: "accent2",
			onPress: onFiles,
		},
		{
			key: "chat",
			label: "chat",
			glyph: "◈",
			tone: "accent2",
			onPress: onChat,
		},
		{
			key: "storage",
			label: "storage",
			glyph: "▦",
			tone: "accent",
			onPress: onStorage,
		},
		{
			key: "tasks",
			label: "tasks",
			glyph: "☑",
			tone: "muted",
			onPress: onTasks,
		},
		{
			key: "calendar",
			label: "calendar",
			glyph: "▤",
			tone: "muted",
			onPress: onCalendar,
		},
		{
			key: "recorder",
			label: "recorder",
			glyph: "◉",
			tone: "accent",
			onPress: onRecorder,
		},
		{
			key: "settings",
			label: "settings",
			glyph: "⚙",
			tone: "muted",
			onPress: onSettings,
		},
		{
			key: "logout",
			label: "logout",
			glyph: "⏻",
			tone: "danger",
			onPress: onLogout,
		},
	];
}

// Glyph color per tone. Labels stay teal everywhere except logout (red), so a
// glance reads "danger" the same way in every layout.
export function toneColor(tone) {
	if (tone === "danger") return colors.accent3;
	if (tone === "muted") return colors.muted;
	if (tone === "accent") return colors.accent;
	return colors.accent2;
}
