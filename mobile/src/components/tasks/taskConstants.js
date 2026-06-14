import { colors } from "../../utils/theme";

export const PRIORITY = ["none", "low", "med", "high"];
// Checkbox tint by priority: none → muted, low → green, med → yellow, high → red.
export const PRIORITY_COLOR = [
	colors.muted,
	colors.accent2,
	colors.accent,
	colors.accent3,
];
// Faint card-background wash per priority (low-alpha hex on the priority hue),
// matching the web cards. Index 0 (none) = no tint.
export const PRIORITY_TINT = [
	"transparent",
	`${colors.accent2}14`,
	`${colors.accent}14`,
	`${colors.accent3}1f`,
];

export const DOW = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const DOW_LABEL = {
	MO: "M",
	TU: "T",
	WE: "W",
	TH: "T",
	FR: "F",
	SA: "S",
	SU: "S",
};

export const buildRrule = (freq, byday) => {
	const parts = [`FREQ=${freq}`];
	if (freq === "WEEKLY" && byday.length) parts.push(`BYDAY=${byday.join(",")}`);
	return parts.join(";");
};

// `alerts` arrives as a JSON array of { offset_minutes, channels? } objects.
export const hasAlerts = (t) => Array.isArray(t.alerts) && t.alerts.length > 0;
