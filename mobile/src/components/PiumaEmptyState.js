import { useEffect, useRef, useState } from "react";
import {
	Animated,
	Easing,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { colors } from "../utils/theme";
import PixelStarfield from "./PixelStarfield";

const MONO = Platform.select({
	ios: "Menlo",
	android: "monospace",
	default: "monospace",
});

const SPRITE = [
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

const PALETTE = {
	B: "#ad7549",
	W: "#f5f5f5",
	M: "#f5f5f5",
	E: "#0d0d0d",
	N: "#000000",
	Y: "#090909",
	T: "#ff7a9a",
	C: "#c0392b",
};

function PiumaPixelArt({ pixelSize = 8 }) {
	const cols = SPRITE[0].length;
	return (
		<View style={{ width: cols * pixelSize }}>
			{SPRITE.map((row, r) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static pixel grid, rows never reorder
				<View key={`row-${r}`} style={{ flexDirection: "row" }}>
					{row.split("").map((code, c) => (
						<View
							// biome-ignore lint/suspicious/noArrayIndexKey: static pixel grid, cells never reorder
							key={`px-${r}-${c}`}
							style={{
								width: pixelSize,
								height: pixelSize,
								backgroundColor: PALETTE[code] || "transparent",
							}}
						/>
					))}
				</View>
			))}
		</View>
	);
}

const QUIPS = [
	"Pick a note, or Piuma keeps floating...",
	"Nothing selected. Piuma is judging you.",
	"Empty. Piuma fetched a whole lot of nothing.",
	"No note open — Piuma's getting dizzy up here.",
	"Go on, click something. Piuma dares you.",
	"404: note not selected. Piuma shrugs.",
];

// A row of chevrons that fades in sequence to imply a swipe direction.
function SwipeChevrons({ dir }) {
	const left = dir === "left";
	const chevs = useRef(
		[`${dir}-0`, `${dir}-1`, `${dir}-2`].map((id) => ({
			id,
			val: new Animated.Value(0.25),
		})),
	).current;

	useEffect(() => {
		// Fade nearest-to-content chevron first so the motion reads as "swipe out".
		const ordered = left ? [...chevs].reverse() : chevs;
		const loop = Animated.loop(
			Animated.stagger(
				140,
				ordered.map((c) =>
					Animated.sequence([
						Animated.timing(c.val, {
							toValue: 1,
							duration: 180,
							useNativeDriver: true,
						}),
						Animated.timing(c.val, {
							toValue: 0.25,
							duration: 420,
							useNativeDriver: true,
						}),
					]),
				),
			),
		);
		loop.start();
		return () => loop.stop();
	}, [chevs, left]);

	const glyph = left ? "‹" : "›";
	return (
		<View style={styles.chevronRow}>
			{chevs.map((c) => (
				<Animated.Text key={c.id} style={[styles.chevron, { opacity: c.val }]}>
					{glyph}
				</Animated.Text>
			))}
		</View>
	);
}

export default function PiumaEmptyState({ onFiles, onChat, onStorage }) {
	// fall: entrance drop from above the layout. float: idle bob after landing.
	const fall = useRef(new Animated.Value(-400)).current;
	const float = useRef(new Animated.Value(0)).current;
	const quipFade = useRef(new Animated.Value(1)).current;
	const [dims, setDims] = useState({ width: 0, height: 0 });
	const [quip, setQuip] = useState(0);

	useEffect(() => {
		let loop;
		Animated.timing(fall, {
			toValue: 0,
			duration: 900,
			easing: Easing.bounce,
			useNativeDriver: true,
		}).start(() => {
			loop = Animated.loop(
				Animated.sequence([
					Animated.timing(float, {
						toValue: 1,
						duration: 1500,
						easing: Easing.inOut(Easing.sin),
						useNativeDriver: true,
					}),
					Animated.timing(float, {
						toValue: 0,
						duration: 1500,
						easing: Easing.inOut(Easing.sin),
						useNativeDriver: true,
					}),
				]),
			);
			loop.start();
		});

		return () => {
			fall.stopAnimation();
			if (loop) loop.stop();
		};
	}, [fall, float]);

	// Cycle the quip every few seconds with a quick cross-fade.
	useEffect(() => {
		const id = setInterval(() => {
			Animated.timing(quipFade, {
				toValue: 0,
				duration: 250,
				useNativeDriver: true,
			}).start(() => {
				setQuip((q) => (q + 1) % QUIPS.length);
				Animated.timing(quipFade, {
					toValue: 1,
					duration: 250,
					useNativeDriver: true,
				}).start();
			});
		}, 3800);
		return () => clearInterval(id);
	}, [quipFade]);

	const floatY = float.interpolate({
		inputRange: [0, 1],
		outputRange: [0, -8],
	});
	const rotate = float.interpolate({
		inputRange: [0, 1],
		outputRange: ["-3deg", "3deg"],
	});

	return (
		<View
			style={styles.container}
			onLayout={(e) => setDims(e.nativeEvent.layout)}
		>
			{dims.width > 0 && (
				<PixelStarfield width={dims.width} height={dims.height} />
			)}
			<Animated.View
				style={{
					transform: [{ translateY: fall }, { translateY: floatY }, { rotate }],
				}}
			>
				<PiumaPixelArt pixelSize={8} />
			</Animated.View>
			<Animated.Text style={[styles.text, { opacity: quipFade }]}>
				{QUIPS[quip]}
			</Animated.Text>
			<View style={styles.hintRow}>
				<Pressable
					onPress={onFiles}
					style={({ pressed }) => [
						styles.hintPill,
						pressed && styles.hintPillPressed,
					]}
				>
					<SwipeChevrons dir="left" />
					<Text style={styles.hintText}>files</Text>
				</Pressable>
				<Text style={styles.hintPaw}>🐾</Text>
				<Pressable
					onPress={onChat}
					style={({ pressed }) => [
						styles.hintPill,
						pressed && styles.hintPillPressed,
					]}
				>
					<Text style={styles.hintText}>chat</Text>
					<SwipeChevrons dir="right" />
				</Pressable>
			</View>
			<Pressable
				onPress={onStorage}
				style={({ pressed }) => [
					styles.storagePill,
					pressed && styles.hintPillPressed,
				]}
			>
				<Text style={styles.storageGlyph}>▦</Text>
				<Text style={styles.hintText}>storage</Text>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.bg,
		gap: 44,
		paddingHorizontal: 24,
	},
	text: {
		color: colors.muted,
		fontSize: 14,
		fontWeight: "600",
		letterSpacing: 0.3,
		lineHeight: 22,
		textAlign: "center",
		fontFamily: MONO,
		maxWidth: 240,
		minHeight: 44,
	},
	hintRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
	},
	hintPill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderWidth: 1,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	hintPillPressed: {
		backgroundColor: colors.bg,
		borderColor: colors.accent,
	},
	storagePill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginTop: -24,
		paddingHorizontal: 16,
		paddingVertical: 8,
		borderWidth: 1,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	storageGlyph: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "700",
	},
	hintText: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1,
		textTransform: "uppercase",
	},
	chevronRow: {
		flexDirection: "row",
	},
	chevron: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "700",
		lineHeight: 14,
	},
	hintPaw: {
		fontSize: 14,
		opacity: 0.8,
	},
});
