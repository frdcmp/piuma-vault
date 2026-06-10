import {
	BODY,
	GALLOP_FRAME_MS,
	GALLOP_LEGS,
	Sprite,
	useSpriteCycle,
} from "../sprites";

// The mascot galloping — the chat "thinking" loader. Body stays fixed; only the
// legs swap through the shared gallop cycle.
export default function PiumaRunning({ pixelSize = 6 }) {
	const frame = useSpriteCycle(GALLOP_LEGS.length, GALLOP_FRAME_MS);
	const rows = [...BODY, ...GALLOP_LEGS[frame]];

	return (
		<span className="piuma-run">
			<Sprite rows={rows} pixelSize={pixelSize} />
		</span>
	);
}
