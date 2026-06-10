import { useSprite } from "./SpriteProvider";

// Presentational pixel grid for a single pose of the active mascot. `rows` is an
// array of equal-length pixel-code strings; renders flex rows of solid-color
// cells using the active mascot's palette. Stateless — animation lives in the
// caller.
export default function Sprite({ rows, pixelSize = 8 }) {
	const { spriteColor, ready } = useSprite();
	// Until the active mascot has actually resolved (or fallen back on error),
	// render nothing rather than flash the baked-in default and swap it out.
	if (!ready) return null;
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
								backgroundColor: spriteColor(code),
							}}
						/>
					))}
				</div>
			))}
		</div>
	);
}
