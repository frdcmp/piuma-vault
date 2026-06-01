import { useEffect, useRef } from "react";
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
import PiumaAvatar from "./PiumaAvatar";
import { BottomBar } from "./SystemBars";

const MONO = Platform.select({
	ios: "Menlo",
	android: "monospace",
	default: "monospace",
});

// Piuma-flavoured "not built yet" copy, picked by feature so each placeholder
// reads a little differently.
const QUIPS = [
	"is still chewing on this one.",
	"buried this feature in the yard, digging it up soon.",
	"hasn't fetched this one yet. Good boy's working on it.",
	"is on it. Tail wagging, code pending.",
];

// Lightweight Piuma-themed placeholder shown when a not-yet-built feature is
// tapped. The parent owns `visible`; pass the feature name for the headline.
export default function ComingSoonModal({
	visible,
	feature,
	quip = 0,
	onClose,
}) {
	// Idle bob for the pixel dog while the modal is open.
	const float = useRef(new Animated.Value(0)).current;

	useEffect(() => {
		if (!visible) return;
		const loop = Animated.loop(
			Animated.sequence([
				Animated.timing(float, {
					toValue: 1,
					duration: 1400,
					easing: Easing.inOut(Easing.sin),
					useNativeDriver: true,
				}),
				Animated.timing(float, {
					toValue: 0,
					duration: 1400,
					easing: Easing.inOut(Easing.sin),
					useNativeDriver: true,
				}),
			]),
		);
		loop.start();
		return () => loop.stop();
	}, [visible, float]);

	const floatY = float.interpolate({
		inputRange: [0, 1],
		outputRange: [0, -6],
	});

	return (
		<Modal
			visible={visible}
			transparent
			animationType="fade"
			onRequestClose={onClose}
		>
			<Pressable style={styles.overlay} onPress={onClose}>
				<Pressable style={styles.card} onPress={() => {}}>
					<Animated.View style={{ transform: [{ translateY: floatY }] }}>
						<PiumaAvatar pixelSize={6} />
					</Animated.View>
					<Text style={styles.title}>Coming soon</Text>
					<Text style={styles.quip}>
						<Text style={styles.feature}>{feature || "This"}</Text>{" "}
						{QUIPS[quip % QUIPS.length]}
					</Text>
					<Text style={styles.sub}>We're working on this feature.</Text>
					<Pressable
						style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
						onPress={onClose}
					>
						<Text style={styles.btnText}>OK</Text>
					</Pressable>
				</Pressable>
			</Pressable>
			<BottomBar />
		</Modal>
	);
}

const styles = StyleSheet.create({
	overlay: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.6)",
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 28,
	},
	card: {
		width: "100%",
		alignItems: "center",
		gap: 12,
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.borderStrong,
		borderStyle: "dashed",
		paddingHorizontal: 20,
		paddingVertical: 24,
	},
	title: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 16,
		fontWeight: "700",
		letterSpacing: 0.5,
	},
	quip: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 13,
		lineHeight: 20,
		textAlign: "center",
	},
	feature: { color: colors.accent2, fontWeight: "700" },
	sub: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		textAlign: "center",
	},
	btn: {
		marginTop: 4,
		paddingHorizontal: 22,
		paddingVertical: 8,
		borderWidth: 2,
		borderColor: colors.accent2,
		backgroundColor: colors.bgSoft,
	},
	btnPressed: { backgroundColor: colors.bg },
	btnText: {
		color: colors.accent2,
		fontFamily: MONO,
		fontSize: 12,
		fontWeight: "700",
		letterSpacing: 1,
	},
});
