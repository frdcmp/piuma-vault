import { useEffect, useState } from "react";

// Pixel-sprite of Piuma galloping — ported from the mobile app's
// PiumaRunning. Shared body rows stay fixed; only the legs swap per frame.
const BODY = [
	"................",
	".....EEBB.......",
	"....EBBBBB......",
	"...BBBBBBBB.....",
	"...BBYBBYBB.BBB.",
	"...BMMNMMBBBBBB.",
	"...BBMTMBBBBBBB.",
	"...CCCCCCCCCCC..",
	"...BWWWWWWWWBB..",
	"...BWWWWWWWWBB..",
];

// Two-frame gallop cycle: front legs reach / land, back legs push / gather.
const RUN_LEGS = [
	["..B.B.....B.B...", "..B.B.......B.B."],
	["....B.B...B.B...", "....B.B..B.B...."],
];

const PALETTE = {
	B: "#ad7549",
	W: "#f5f5f5",
	M: "#f5f5f5",
	E: "#0d0d0d",
	N: "#000000",
	Y: "#090909",
	T: "#ff7a9a",
	C: "#c0392b",
};

const FRAME_MS = 140;

function Sprite({ rows, pixelSize }) {
	return (
		<div style={{ lineHeight: 0 }}>
			{rows.map((row, r) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static sprite rows
				<div key={r} style={{ display: "flex" }}>
					{row.split("").map((code, c) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static sprite columns
							key={c}
							style={{
								width: pixelSize,
								height: pixelSize,
								background: PALETTE[code] || "transparent",
							}}
						/>
					))}
				</div>
			))}
		</div>
	);
}

export default function PiumaRunning({ pixelSize = 6 }) {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const id = setInterval(() => {
			setFrame((f) => (f + 1) % RUN_LEGS.length);
		}, FRAME_MS);
		return () => clearInterval(id);
	}, []);

	const rows = [...BODY, ...RUN_LEGS[frame]];

	return (
		<span className="piuma-run">
			<Sprite rows={rows} pixelSize={pixelSize} />
		</span>
	);
}
