import { useState } from "react";
import { StyleSheet, View } from "react-native";

// Decorative backdrop for the notes explorer: a very subtle pixel grid across
// the whole panel. Built from plain Views (no SVG dep) and measured via
// onLayout; static, behind the list, and pointer-transparent.

const GRID_GAP = 12;

function PixelGrid({ w, h }) {
	if (!w || !h) return null;
	const cols = Math.ceil(w / GRID_GAP);
	const rows = Math.ceil(h / GRID_GAP);
	const line = "rgba(255,255,255,0.012)";
	return (
		<View style={StyleSheet.absoluteFill} pointerEvents="none">
			{Array.from({ length: cols }, (_, i) => (
				<View
					// biome-ignore lint/suspicious/noArrayIndexKey: static grid lines never reorder
					key={`v${i}`}
					style={{
						position: "absolute",
						left: i * GRID_GAP,
						top: 0,
						bottom: 0,
						width: 1,
						backgroundColor: line,
					}}
				/>
			))}
			{Array.from({ length: rows }, (_, i) => (
				<View
					// biome-ignore lint/suspicious/noArrayIndexKey: static grid lines never reorder
					key={`h${i}`}
					style={{
						position: "absolute",
						top: i * GRID_GAP,
						left: 0,
						right: 0,
						height: 1,
						backgroundColor: line,
					}}
				/>
			))}
		</View>
	);
}

export default function ExplorerBackdrop() {
	const [size, setSize] = useState({ w: 0, h: 0 });
	return (
		<View
			style={StyleSheet.absoluteFill}
			pointerEvents="none"
			onLayout={(e) => {
				const { width, height } = e.nativeEvent.layout;
				setSize((prev) =>
					prev.w === width && prev.h === height
						? prev
						: { w: width, h: height },
				);
			}}
		>
			<PixelGrid w={size.w} h={size.h} />
		</View>
	);
}
