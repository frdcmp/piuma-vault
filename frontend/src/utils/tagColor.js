// Deterministic tag color. Maps the first two letters of a string to a stable
// hue, tuned to read well on the dark pixel/terminal background. The same logic
// lives in the mobile app (mobile/src/utils/tagColor.js) so a given tag looks
// identical on web and mobile.

export function tagColor(value) {
	const s = String(value ?? "")
		.trim()
		.toLowerCase();
	const a = s.charCodeAt(0);
	const b = s.charCodeAt(1);
	// NaN (empty / single-char input) collapses to 0 so short tags stay stable.
	const c0 = Number.isNaN(a) ? 0 : a;
	const c1 = Number.isNaN(b) ? 0 : b;
	const hue = (c0 * 37 + c1 * 17) % 360;
	return `hsl(${hue}, 62%, 68%)`;
}
