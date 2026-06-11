import DEFAULT_CHARACTER from "./fallback-sprite";

// Standalone render of the baked-in Piuma sprite, colored from its OWN palette
// and independent of <SpriteProvider>. Use on public pages (e.g. /docs) that
// should always show Piuma regardless of the DB-selected mascot — unlike
// <Sprite>, which reads palette + ready-state from context.
const ROWS = [...DEFAULT_CHARACTER.body, ...DEFAULT_CHARACTER.idleLegs];
const colorFor = (code) => DEFAULT_CHARACTER.palette[code] || "transparent";

export default function FallbackSprite({ pixelSize = 8 }) {
	return (
		<div style={{ lineHeight: 0 }}>
			{ROWS.map((row, r) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static sprite rows never reorder
				<div key={r} style={{ display: "flex" }}>
					{row.split("").map((code, c) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: static sprite cells never reorder
							key={c}
							style={{
								width: pixelSize,
								height: pixelSize,
								backgroundColor: colorFor(code),
							}}
						/>
					))}
				</div>
			))}
		</div>
	);
}
