import { useState } from "react";
import "./PiumaPixelArt.css";

const RAW_DOG_SPRITE = [
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
	"...B.B....B.B...",
	"...B.B....B.B...",
];

function codeToColor(code) {
	switch (code) {
		case "B":
			return "#ad7549"; // base
		case "W":
			return "#f5f5f5"; // belly
		case "M":
			return "#f5f5f5"; // muzzle
		case "E":
			return "#0d0d0d"; // ear
		case "N":
			return "#000000"; // nose
		case "Y":
			return "#090909"; // eye
		case "T":
			return "#ff7a9a"; // tongue
		case "C":
			return "#c0392b"; // collar
		default:
			return null;
	}
}

export default function PiumaPixelArt({ pixelSize = 8 }) {
	const cols = RAW_DOG_SPRITE[0].length;
	const rows = RAW_DOG_SPRITE.length;
	// Toggled on click to play a one-shot jump that overrides the idle float.
	const [jumping, setJumping] = useState(false);

	return (
		<button
			type="button"
			className={`piuma-pixel-art${jumping ? " is-jumping" : ""}`}
			aria-label="Boop Piuma"
			onClick={() => setJumping(true)}
			onAnimationEnd={(e) => {
				if (e.animationName === "piuma-jump") setJumping(false);
			}}
			style={{
				display: "grid",
				gridTemplateColumns: `repeat(${cols}, ${pixelSize}px)`,
				gridTemplateRows: `repeat(${rows}, ${pixelSize}px)`,
				width: cols * pixelSize,
				height: rows * pixelSize,
			}}
		>
			{RAW_DOG_SPRITE.map((row, r) =>
				row.split("").map((code, c) => {
					const color = codeToColor(code);
					return (
						<div
							key={`${r}-${c}`}
							style={{
								width: pixelSize,
								height: pixelSize,
								backgroundColor: color || "transparent",
							}}
						/>
					);
				}),
			)}
		</button>
	);
}
