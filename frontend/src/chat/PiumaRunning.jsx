import PiumaSprite from "../sprites/PiumaSprite";
import {
	PIUMA_BODY,
	PIUMA_GALLOP_FRAME_MS,
	PIUMA_GALLOP_LEGS,
} from "../sprites/piuma";
import useSpriteCycle from "../sprites/useSpriteCycle";

// Piuma galloping — the chat "thinking" loader. Body stays fixed; only the legs
// swap through the shared gallop cycle.
export default function PiumaRunning({ pixelSize = 6 }) {
	const frame = useSpriteCycle(PIUMA_GALLOP_LEGS.length, PIUMA_GALLOP_FRAME_MS);
	const rows = [...PIUMA_BODY, ...PIUMA_GALLOP_LEGS[frame]];

	return (
		<span className="piuma-run">
			<PiumaSprite rows={rows} pixelSize={pixelSize} />
		</span>
	);
}
