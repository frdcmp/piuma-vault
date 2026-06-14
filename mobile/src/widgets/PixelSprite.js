import { FlexWidget } from "react-native-android-widget";
import fallbackSprite from "../sprites/fallback-sprite";

// Renders the baked-in Piuma mascot as a pixel grid inside a widget.
//
// Android widgets run in a RemoteViews context that can't host the View-based
// <Sprite> component (or the DB-backed active mascot, which needs SpriteProvider
// + network). So we draw the code-resident fallback sprite directly with
// FlexWidget boxes, run-length-encoding each row so a 16-wide row becomes a
// handful of boxes instead of 16 — keeping the RemoteViews view count low.

const { palette, body, idleLegs } = fallbackSprite;

// The idle pose: 10 shared body rows + the 2 standing-leg rows.
const POSE = [...body, ...idleLegs];

// Group a row string into [{ code, len }] runs of consecutive equal codes.
function runsFor(row) {
	const runs = [];
	for (const code of row) {
		const last = runs[runs.length - 1];
		if (last && last.code === code) last.len += 1;
		else runs.push({ code, len: 1 });
	}
	return runs;
}

// Pre-compute runs once at module load — the pose never changes.
const POSE_RUNS = POSE.map(runsFor);

// `code` → fill color, or null for transparent ('.' / anything unmapped).
function fillFor(code) {
	return palette[code] ?? null;
}

// Draws Piuma at `pixelSize` px per cell (sprite is 16 wide × 12 tall).
export function PixelSprite({ pixelSize = 3 }) {
	return (
		<FlexWidget style={{ flexDirection: "column" }}>
			{POSE_RUNS.map((runs, r) => {
				let x = 0;
				return (
					<FlexWidget
						// biome-ignore lint/suspicious/noArrayIndexKey: static sprite rows never reorder
						key={`row-${r}`}
						style={{ flexDirection: "row", height: pixelSize }}
					>
						{runs.map((run) => {
							const fill = fillFor(run.code);
							const key = `c-${r}-${x}`;
							x += run.len;
							return (
								<FlexWidget
									key={key}
									style={{
										width: run.len * pixelSize,
										height: pixelSize,
										...(fill ? { backgroundColor: fill } : {}),
									}}
								/>
							);
						})}
					</FlexWidget>
				);
			})}
		</FlexWidget>
	);
}
