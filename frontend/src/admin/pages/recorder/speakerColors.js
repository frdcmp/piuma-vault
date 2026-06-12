// Speaker color palette — shared between the live terminal and the saved
// transcript detail page. Colors cycle in insertion order, so the first speaker
// label encountered always gets orange, the second green, etc.
const SPEAKER_COLORS = [
	"#f97316", // orange
	"#22c55e", // green
	"#a855f7", // purple
	"#06b6d4", // cyan
	"#ec4899", // pink
	"#eab308", // yellow
	"#3b82f6", // blue
	"#14b8a6", // teal
];

const speakerMap = {};
let colorIdx = 0;

/**
 * Return a stable color for a speaker label.
 * Pass `null` or `undefined` to get `null` back (no speaker → no color tag).
 */
export const colorForSpeaker = (label) => {
	if (!label) return null;
	if (!speakerMap[label]) {
		speakerMap[label] = SPEAKER_COLORS[colorIdx % SPEAKER_COLORS.length];
		colorIdx++;
	}
	return speakerMap[label];
};

/** Reset all speaker→color assignments (call when starting a new session). */
export const resetSpeakerColors = () => {
	Object.keys(speakerMap).forEach((k) => delete speakerMap[k]);
	colorIdx = 0;
};
