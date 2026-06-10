import { useState } from "react";
import { StyleSheet, View } from "react-native";

// Decorative backdrop for the notes explorer: a very dull pixel grid across the
// whole panel plus a low-contrast grey pixel landscape pinned to the bottom.
// Mirrors the web FtreeScene/grid. Built from plain Views (no SVG dep) and
// measured via onLayout; static, behind the list, and pointer-transparent.

const COLS = 48;
const ROWS = 22;
const SCENE_H = 120;
const GRID_GAP = 16;

// Deterministic rolling-hill profiles (top row per column; smaller = taller).
const backTop = Array.from({ length: COLS }, (_, x) =>
	Math.round(11 + 2.5 * Math.sin(x / 7) + 1.5 * Math.sin(x / 3 + 1)),
);
const frontTop = Array.from({ length: COLS }, (_, x) =>
	Math.round(15 + 2 * Math.sin(x / 5 + 2) + Math.sin(x / 2)),
);

// Dim star field — fixed positions in column/row units.
const STARS = [
	{ x: 4, y: 3 },
	{ x: 10, y: 6 },
	{ x: 16, y: 2 },
	{ x: 23, y: 5 },
	{ x: 29, y: 3 },
	{ x: 34, y: 7 },
	{ x: 42, y: 4 },
	{ x: 46, y: 2 },
];

const PINES = [12, 33];

function PixelGrid({ w, h }) {
	if (!w || !h) return null;
	const cols = Math.ceil(w / GRID_GAP);
	const rows = Math.ceil(h / GRID_GAP);
	const line = "rgba(255,255,255,0.022)";
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

function Scene({ w }) {
	if (!w) return null;
	const colW = w / COLS;
	const rowH = SCENE_H / ROWS;
	// One solid bar per column from `top` down to the ground.
	const bar = (x, top, color, key, dy = 0) => (
		<View
			key={key}
			style={{
				position: "absolute",
				left: x * colW,
				top: (top + dy) * rowH,
				width: colW + 0.5,
				height: (ROWS - top - dy) * rowH + 0.5,
				backgroundColor: color,
			}}
		/>
	);
	const dot = (x, y, size, color, key) => (
		<View
			key={key}
			style={{
				position: "absolute",
				left: x * colW,
				top: y * rowH,
				width: size,
				height: size,
				backgroundColor: color,
			}}
		/>
	);

	return (
		<View
			pointerEvents="none"
			style={{
				position: "absolute",
				left: 0,
				right: 0,
				bottom: 0,
				height: SCENE_H,
				opacity: 0.7,
			}}
		>
			{/* Moon */}
			<View
				style={{
					position: "absolute",
					left: 39 * colW,
					top: 3 * rowH,
					width: colW * 4,
					height: rowH * 4,
					borderRadius: colW * 2,
					backgroundColor: "#9a8340",
				}}
			/>

			{/* Stars */}
			{STARS.map((s) => dot(s.x, s.y, 2, "#5b6373", `s${s.x}-${s.y}`))}

			{/* Distant hills */}
			{backTop.map((t, x) => bar(x, t, "#21242b", `b${x}`))}

			{/* Foreground hill: grey cap over darker body */}
			{frontTop.map((t, x) => bar(x, t, "#2b2f37", `fc${x}`))}
			{frontTop.map((t, x) => bar(x, t, "#1d2027", `fb${x}`, 1))}

			{/* Pines */}
			{PINES.map((cx) => {
				const base = frontTop[cx];
				return (
					<View key={`p${cx}`}>
						{bar(cx, base - 1, "#23252b", `pt${cx}`)}
						<View
							style={{
								position: "absolute",
								left: (cx - 1) * colW,
								top: (base - 2) * rowH,
								width: colW * 3,
								height: rowH,
								backgroundColor: "#282c33",
							}}
						/>
						<View
							style={{
								position: "absolute",
								left: cx * colW,
								top: (base - 3) * rowH,
								width: colW,
								height: rowH,
								backgroundColor: "#30343d",
							}}
						/>
					</View>
				);
			})}
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
			<Scene w={size.w} />
		</View>
	);
}
