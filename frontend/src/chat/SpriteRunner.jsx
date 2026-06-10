import { Sprite, useSprite, useSpriteCycle } from "../sprites";

// The mascot galloping — the chat "thinking" loader. Body stays fixed; only the
// legs swap through the active mascot's gallop cycle.
export default function PiumaRunning({ pixelSize = 6 }) {
	const { body, gallopLegs, gallopFrameMs } = useSprite();
	const frame = useSpriteCycle(gallopLegs.length, gallopFrameMs);
	const rows = [...body, ...gallopLegs[frame]];

	return (
		<span className="piuma-run">
			<Sprite rows={rows} pixelSize={pixelSize} />
		</span>
	);
}
