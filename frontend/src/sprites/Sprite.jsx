import { spriteColor } from "./index";

// Presentational pixel grid for a single pose of the active mascot. `rows` is an
// array of equal-length pixel-code strings (see ./index.js); renders flex rows
// of solid-color cells. Stateless — animation lives in the caller.
export default function Sprite({ rows, pixelSize = 8 }) {
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
