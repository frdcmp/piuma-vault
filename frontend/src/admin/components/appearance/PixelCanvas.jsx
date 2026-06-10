import { useEffect, useRef } from "react";

// Clickable/draggable pixel grid. `rows` is an array of equal-length code
// strings; left-click paints the `paint` code, right-click (or right-drag)
// quick-erases to transparent ("."). Calls `onChange(nextRows)`.
export default function PixelCanvas({
	rows,
	palette,
	paint,
	onChange,
	scale = 18,
}) {
	const painting = useRef(false);
	const erasing = useRef(false);

	// Release the drag even if the pointer comes up outside the grid.
	useEffect(() => {
		const stop = () => {
			painting.current = false;
		};
		window.addEventListener("pointerup", stop);
		return () => window.removeEventListener("pointerup", stop);
	}, []);

	const setCell = (r, c, code) => {
		const row = rows[r];
		if (row[c] === code) return;
		const nextRow = row.slice(0, c) + code + row.slice(c + 1);
		onChange(rows.map((x, i) => (i === r ? nextRow : x)));
	};

	const paintCell = (r, c) => setCell(r, c, erasing.current ? "." : paint);

	const color = (code) => palette[code] || "transparent";

	return (
		<div
			className="vp-pixcanvas"
			style={{ lineHeight: 0, touchAction: "none", width: "fit-content" }}
		>
			{rows.map((row, r) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed grid, rows never reorder
				<div key={r} style={{ display: "flex" }}>
					{row.split("").map((code, c) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed grid, cells never reorder
							key={c}
							type="button"
							aria-label={`pixel ${r},${c}`}
							// Right-click erases instead of opening the browser menu.
							onContextMenu={(e) => e.preventDefault()}
							onPointerDown={(e) => {
								e.preventDefault();
								erasing.current = e.button === 2;
								painting.current = true;
								paintCell(r, c);
							}}
							onPointerEnter={() => {
								if (painting.current) paintCell(r, c);
							}}
							className="vp-pixcell"
							style={{
								width: scale,
								height: scale,
								backgroundColor: color(code),
								// Faint checker so transparent cells stay visible.
								backgroundImage:
									code === "." || !palette[code]
										? "linear-gradient(45deg,#222 25%,transparent 25%,transparent 75%,#222 75%),linear-gradient(45deg,#222 25%,transparent 25%,transparent 75%,#222 75%)"
										: "none",
								backgroundSize: `${scale / 2}px ${scale / 2}px`,
								backgroundPosition: `0 0, ${scale / 4}px ${scale / 4}px`,
							}}
						/>
					))}
				</div>
			))}
		</div>
	);
}
