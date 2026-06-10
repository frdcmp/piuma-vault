import { useEffect, useState } from "react";

// Cycle 0..frameCount-1 on a fixed interval — for interval-driven sprite
// animations (loaders). Returns the current frame index. Pass active=false to
// freeze on frame 0.
export default function useSpriteCycle(frameCount, frameMs, active = true) {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		if (!active || frameCount <= 1) {
			setFrame(0);
			return undefined;
		}
		const id = setInterval(
			() => setFrame((f) => (f + 1) % frameCount),
			frameMs,
		);
		return () => clearInterval(id);
	}, [frameCount, frameMs, active]);
	return frame;
}
