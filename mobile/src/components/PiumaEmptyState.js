import { useEffect, useRef, useState } from "react";
import {
	Animated,
	Easing,
	Modal,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { colors } from "../utils/theme";
import ComingSoonModal from "./ComingSoonModal";
import PixelStarfield from "./PixelStarfield";
import { BottomBar } from "./SystemBars";

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

export default function PiumaEmptyState({
	onFiles,
	onChat,
	onStorage,
	onTasks,
	onCalendar,
	onLogout,
}) {
	// fall: entrance drop from above the layout. float: idle bob after landing.
	const fall = useRef(new Animated.Value(-400)).current;
	const float = useRef(new Animated.Value(0)).current;
	const caret = useRef(new Animated.Value(1)).current;
	// jump: one-shot hop played when Piuma is tapped (0 = grounded).
	const jump = useRef(new Animated.Value(0)).current;
	const [dims, setDims] = useState({ width: 0, height: 0 });
	// Text currently typed out by the terminal-style typewriter.
	const [typed, setTyped] = useState("");
	// Placeholder for not-yet-built features: holds the tapped feature's label
	// (and a quip index) while the "coming soon" modal is open, or null.
	const [comingSoon, setComingSoon] = useState(null);
	// Whether the logout confirmation dialog is showing.
	const [confirmLogout, setConfirmLogout] = useState(false);

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

	// Terminal-style typewriter: type a quip out char by char, hold, backspace
	// it, then move to the next one. A single recursive timeout chain drives the
	// whole cycle so the speeds stay independent of React's render cadence.
	useEffect(() => {
		const TYPE_MS = 55; // per character typed
		const DELETE_MS = 25; // per character erased
		const HOLD_MS = 2400; // pause on the full line
		const GAP_MS = 500; // pause on the empty line before the next quip
		let quipIndex = 0;
		let charIndex = 0;
		let deleting = false;
		let timeout;

		const tick = () => {
			const full = QUIPS[quipIndex];
			if (!deleting) {
				charIndex += 1;
				setTyped(full.slice(0, charIndex));
				if (charIndex >= full.length) {
					deleting = true;
					timeout = setTimeout(tick, HOLD_MS);
				} else {
					timeout = setTimeout(tick, TYPE_MS);
				}
			} else {
				charIndex -= 1;
				setTyped(full.slice(0, charIndex));
				if (charIndex <= 0) {
					deleting = false;
					quipIndex = (quipIndex + 1) % QUIPS.length;
					timeout = setTimeout(tick, GAP_MS);
				} else {
					timeout = setTimeout(tick, DELETE_MS);
				}
			}
		};

		timeout = setTimeout(tick, GAP_MS);
		return () => clearTimeout(timeout);
	}, []);

	// Blinking terminal caret that trails the typed text (1s hard blink).
	useEffect(() => {
		const loop = Animated.loop(
			Animated.sequence([
				Animated.timing(caret, {
					toValue: 0,
					duration: 0,
					delay: 500,
					useNativeDriver: true,
				}),
				Animated.timing(caret, {
					toValue: 1,
					duration: 0,
					delay: 500,
					useNativeDriver: true,
				}),
			]),
		);
		loop.start();
		return () => loop.stop();
	}, [caret]);

	const floatY = float.interpolate({
		inputRange: [0, 1],
		outputRange: [0, -8],
	});
	const rotate = float.interpolate({
		inputRange: [0, 1],
		outputRange: ["-3deg", "3deg"],
	});
	// 0 → grounded, 1 → top of the hop.
	const jumpY = jump.interpolate({
		inputRange: [0, 1],
		outputRange: [0, -40],
	});

	// Play a quick up-and-down hop. Ignores taps while already mid-jump.
	const boop = () => {
		jump.stopAnimation((v) => {
			if (v > 0) return;
			Animated.sequence([
				Animated.timing(jump, {
					toValue: 1,
					duration: 220,
					easing: Easing.out(Easing.quad),
					useNativeDriver: true,
				}),
				Animated.timing(jump, {
					toValue: 0,
					duration: 260,
					easing: Easing.bounce,
					useNativeDriver: true,
				}),
			]).start();
		});
	};

	return (
		<View
			style={styles.container}
			onLayout={(e) => setDims(e.nativeEvent.layout)}
		>
			{dims.width > 0 && (
				<PixelStarfield width={dims.width} height={dims.height} />
			)}
			<Pressable onPress={boop} accessibilityLabel="Boop Piuma">
				<Animated.View
					style={{
						transform: [
							{ translateY: fall },
							{ translateY: floatY },
							{ translateY: jumpY },
							{ rotate },
						],
					}}
				>
					<PiumaPixelArt pixelSize={8} />
				</Animated.View>
			</Pressable>
			<Text style={styles.text}>
				{typed}
				<Animated.Text style={[styles.caret, { opacity: caret }]}>
					▋
				</Animated.Text>
			</Text>
			<View style={styles.hintRow}>
				<Pressable
					onPress={onFiles}
					style={({ pressed }) => [
						styles.hintPill,
						pressed && styles.hintPillPressed,
					]}
				>
					<SwipeChevrons dir="left" />
					<Text style={styles.hintText}>notes</Text>
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
			{/* Vertical menu — Storage is live; Tasks/Calendar are placeholders. */}
			<View style={styles.menuList}>
				<Pressable
					onPress={onStorage}
					style={({ pressed }) => [
						styles.menuItem,
						pressed && styles.menuItemPressed,
					]}
				>
					<Text style={styles.storageGlyph}>▦</Text>
					<Text style={styles.hintText}>storage</Text>
				</Pressable>
				<Pressable
					onPress={onTasks}
					style={({ pressed }) => [
						styles.menuItem,
						pressed && styles.menuItemPressed,
					]}
				>
					<Text style={styles.futureGlyph}>☑</Text>
					<Text style={styles.hintText}>tasks</Text>
				</Pressable>
				<Pressable
					onPress={onCalendar}
					style={({ pressed }) => [
						styles.menuItem,
						pressed && styles.menuItemPressed,
					]}
				>
					<Text style={styles.futureGlyph}>▤</Text>
					<Text style={styles.hintText}>calendar</Text>
				</Pressable>
				<Pressable
					onPress={() => setConfirmLogout(true)}
					style={({ pressed }) => [
						styles.menuItem,
						pressed && styles.menuItemPressed,
					]}
				>
					<Text style={styles.logoutGlyph}>⏻</Text>
					<Text style={[styles.hintText, styles.logoutText]}>logout</Text>
				</Pressable>
			</View>

			<ComingSoonModal
				visible={!!comingSoon}
				feature={comingSoon?.label}
				quip={comingSoon?.quip || 0}
				onClose={() => setComingSoon(null)}
			/>

			{/* Logout confirmation */}
			<Modal
				visible={confirmLogout}
				transparent
				animationType="fade"
				onRequestClose={() => setConfirmLogout(false)}
			>
				<Pressable
					style={styles.confirmOverlay}
					onPress={() => setConfirmLogout(false)}
				>
					<Pressable style={styles.confirmCard} onPress={() => {}}>
						<Text style={styles.confirmTitle}>Log out?</Text>
						<Text style={styles.confirmHint}>
							Piuma will miss you. You'll need to sign back in.
						</Text>
						<View style={styles.confirmActions}>
							<Pressable
								style={({ pressed }) => [
									styles.confirmBtn,
									pressed && styles.menuItemPressed,
								]}
								onPress={() => setConfirmLogout(false)}
							>
								<Text style={styles.confirmBtnText}>Cancel</Text>
							</Pressable>
							<Pressable
								style={({ pressed }) => [
									styles.confirmBtn,
									styles.confirmBtnDanger,
									pressed && styles.menuItemPressed,
								]}
								onPress={() => {
									setConfirmLogout(false);
									onLogout?.();
								}}
							>
								<Text
									style={[styles.confirmBtnText, styles.confirmBtnTextDanger]}
								>
									Log out
								</Text>
							</Pressable>
						</View>
					</Pressable>
				</Pressable>
				<BottomBar />
			</Modal>
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
	caret: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 14,
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
	menuList: {
		alignItems: "center",
		marginTop: 8,
		gap: 16,
	},
	menuItem: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 10,
		paddingVertical: 4,
	},
	menuItemSoon: {
		opacity: 0.6,
	},
	menuItemPressed: {
		opacity: 0.45,
	},
	storageGlyph: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "700",
		width: 18,
		textAlign: "center",
	},
	futureGlyph: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "700",
		width: 18,
		textAlign: "center",
	},
	logoutGlyph: {
		color: colors.accent3,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "700",
		width: 18,
		textAlign: "center",
	},
	logoutText: {
		color: colors.accent3,
	},
	confirmOverlay: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.6)",
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 28,
	},
	confirmCard: {
		width: "100%",
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		borderStyle: "dashed",
		padding: 18,
	},
	confirmTitle: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 16,
		fontWeight: "700",
	},
	confirmHint: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		marginTop: 4,
		marginBottom: 12,
	},
	confirmActions: {
		flexDirection: "row",
		justifyContent: "flex-end",
		gap: 8,
		marginTop: 8,
	},
	confirmBtn: {
		paddingHorizontal: 14,
		paddingVertical: 8,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		backgroundColor: colors.bgSoft,
	},
	confirmBtnDanger: { borderColor: colors.accent3 },
	confirmBtnText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "700",
	},
	confirmBtnTextDanger: { color: colors.accent3 },
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
