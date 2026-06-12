import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "../../utils/theme";

// Mirrored "specular" pixel waveform — native port of the web PixelWaveform.
// The recorder writes per-bar peak amplitudes (0..1) into `barsRef` from each
// PCM chunk; each bar maps to a slice of the current frame (not a moment in
// time), so it pulses in place, symmetric around the centerline — green at the
// centre → amber → red at the tips. Bars rise fast, decay slow. With fresh data
// every ~100ms (the emit cadence) and a faster redraw + decay, it stays fluid.

const BARS = 28;
const FPS_MS = 40; // redraw cadence (decay smooths between data points)
const DECAY = 0.08; // how far a bar can fall per frame

const barColor = (h) =>
	h > 0.66 ? colors.accent3 : h > 0.33 ? colors.accent : colors.accent2;

export default function Waveform({ barsRef, active, height = 96 }) {
	const [, force] = useState(0);
	const heightsRef = useRef(new Array(BARS).fill(0));

	useEffect(() => {
		const id = setInterval(() => {
			const data = active ? barsRef?.current : null;
			const h = heightsRef.current;
			for (let i = 0; i < BARS; i++) {
				const t = data ? Math.min(1, data[i] || 0) : 0;
				// Rise instantly to a higher peak, decay slowly otherwise.
				h[i] = t > h[i] ? t : Math.max(0, h[i] - DECAY);
			}
			force((c) => (c + 1) & 0xffff);
		}, FPS_MS);
		return () => clearInterval(id);
	}, [active, barsRef]);

	const half = (height - 8) / 2;

	return (
		<View style={[styles.row, { height }]}>
			{heightsRef.current.map((h, i) => (
				<View
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length bar grid
					key={i}
					style={{
						width: 5,
						height: Math.max(3, h * half * 2),
						backgroundColor: active ? barColor(h) : colors.border,
						opacity: active ? 0.5 + h * 0.5 : 0.45,
					}}
				/>
			))}
		</View>
	);
}

const styles = StyleSheet.create({
	row: {
		flexDirection: "row",
		alignItems: "center", // centers each bar → mirrored top/bottom
		justifyContent: "center",
		gap: 3,
		width: "100%",
	},
});
