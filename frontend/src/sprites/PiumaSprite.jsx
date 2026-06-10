import { piumaColor } from "./piuma";

// Presentational pixel grid for a single Piuma pose. `rows` is an array of
// equal-length pixel-code strings (see piuma.js); renders flex rows of
// solid-color cells. Stateless — animation lives in the caller.
export default function PiumaSprite({ rows, pixelSize = 8 }) {
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
								backgroundColor: piumaColor(code),
							}}
						/>
					))}
				</div>
			))}
		</div>
	);
}
