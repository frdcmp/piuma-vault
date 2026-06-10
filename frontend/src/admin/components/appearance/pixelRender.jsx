import { useSpriteCycle } from "../../../sprites";

// Renderers that take an EXPLICIT palette (unlike the app's <Sprite>, which uses
// the active mascot's palette from context). Used by the Appearance list and the
// editor so each sprite previews with its own colors while being edited.

export function SpritePreview({ rows, palette, pixelSize = 6 }) {
	const color = (code) => palette[code] || "transparent";
	return (
		<div style={{ lineHeight: 0 }}>
			{rows.map((row, r) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static sprite rows never reorder
				<div key={r} style={{ display: "flex" }}>
					{row.split("").map((code, c) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: static sprite cells never reorder
							key={c}
							style={{
								width: pixelSize,
								height: pixelSize,
								backgroundColor: color(code),
							}}
						/>
					))}
				</div>
			))}
		</div>
	);
}

// Cycles `frames` (each a 2-row leg strip) under a fixed `body` at `frameMs`.
export function AnimatedPreview({
	body,
	frames,
	frameMs,
	palette,
	pixelSize = 6,
}) {
	const safe = frames?.length ? frames : [[]];
	const frame = useSpriteCycle(safe.length, frameMs || 120);
	const rows = [...body, ...(safe[frame] || safe[0])];
	return <SpritePreview rows={rows} palette={palette} pixelSize={pixelSize} />;
}
