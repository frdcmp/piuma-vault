import { Ionicons } from "@expo/vector-icons";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
	Animated,
	Dimensions,
	Modal,
	PanResponder,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../utils/theme";
import { BottomBar } from "./SystemBars";

const MONO = Platform.select({
	ios: "Menlo",
	android: "monospace",
	default: "monospace",
});

const SCREEN_H = Dimensions.get("window").height;
// translateY is driven on the JS thread (useNativeDriver: false) so that the
// per-frame `setValue(g.dy)` during a drag actually moves the sheet. With the
// native driver the value lives on the native side and JS setValue calls don't
// reflect on screen — which makes the drag-to-dismiss handle feel dead.
const SPRING = {
	useNativeDriver: false,
	damping: 24,
	stiffness: 240,
	mass: 0.7,
};

// Lets BottomSheet.Item dismiss the sheet after running its action.
const SheetClose = createContext(() => {});

/**
 * Reusable bottom sheet. The parent owns `visible`; the sheet animates in/out
 * and unmounts itself after the exit animation. Dismiss by dragging it down or
 * tapping the backdrop — no cancel button. Bottom padding respects the device
 * safe area (Android gesture/nav bar) so the last row is never clipped.
 */
export default function BottomSheet({
	visible,
	onClose,
	onClosed,
	title,
	subtitle,
	children,
}) {
	const insets = useSafeAreaInsets();
	const [mounted, setMounted] = useState(visible);
	const translateY = useRef(new Animated.Value(SCREEN_H)).current;

	// Mount as soon as the parent asks to open.
	useEffect(() => {
		if (visible) setMounted(true);
	}, [visible]);

	// Slide in once mounted.
	useEffect(() => {
		if (mounted && visible) {
			translateY.setValue(SCREEN_H);
			Animated.spring(translateY, { toValue: 0, ...SPRING }).start();
		}
	}, [mounted, visible, translateY]);

	// Slide out when the parent closes, then unmount. `onClosed` fires only
	// after the sheet is fully gone — callers rely on this to open a follow-up
	// modal without it overlapping the sheet (RN can't show two modals at once).
	useEffect(() => {
		if (!visible && mounted) {
			Animated.timing(translateY, {
				toValue: SCREEN_H,
				duration: 200,
				useNativeDriver: false,
			}).start(({ finished }) => {
				if (finished) {
					setMounted(false);
					onClosed?.();
				}
			});
		}
	}, [visible, mounted, translateY, onClosed]);

	const pan = useRef(
		PanResponder.create({
			// Claim the touch as soon as it lands on the grab zone (and on any
			// move), so every drag is routed here. The grab zone holds no
			// buttons, so grabbing the start touch costs nothing.
			onStartShouldSetPanResponder: () => true,
			onStartShouldSetPanResponderCapture: () => true,
			onMoveShouldSetPanResponder: () => true,
			onMoveShouldSetPanResponderCapture: () => true,
			// Kill any in-flight slide animation so the sheet follows the finger.
			onPanResponderGrant: () => {
				translateY.stopAnimation();
			},
			onPanResponderMove: (_, g) => {
				// Downward drags track 1:1; upward drags get heavy resistance so
				// the sheet can't be pulled above its resting position.
				translateY.setValue(g.dy > 0 ? g.dy : g.dy / 6);
			},
			onPanResponderRelease: (_, g) => {
				if (g.dy > 80 || g.vy > 0.5) onClose?.();
				else Animated.spring(translateY, { toValue: 0, ...SPRING }).start();
			},
			onPanResponderTerminationRequest: () => false,
			onShouldBlockNativeResponder: () => true,
		}),
	).current;

	if (!mounted) return null;

	return (
		<Modal visible transparent animationType="none" onRequestClose={onClose}>
			<SheetClose.Provider value={onClose}>
				<View style={StyleSheet.absoluteFill}>
					<Pressable style={styles.backdrop} onPress={onClose} />
					<Animated.View
						style={[
							styles.sheet,
							{
								transform: [{ translateY }],
								paddingBottom: Math.max(insets.bottom, 8) + 12,
							},
						]}
					>
						<View style={styles.grabZone} {...pan.panHandlers}>
							<View style={styles.handle} />
							{title ? (
								<Text style={styles.title} numberOfLines={1}>
									{title}
								</Text>
							) : null}
							{subtitle ? (
								<Text style={styles.subtitle} numberOfLines={1}>
									{subtitle}
								</Text>
							) : null}
						</View>
						{children}
					</Animated.View>
					<BottomBar />
				</View>
			</SheetClose.Provider>
		</Modal>
	);
}

/** A single tappable row. Runs `onPress`, then dismisses the sheet. */
export function BottomSheetItem({ icon, label, color, onPress }) {
	const close = useContext(SheetClose);
	return (
		<TouchableOpacity
			style={styles.item}
			activeOpacity={0.6}
			onPress={() => {
				onPress?.();
				close?.();
			}}
		>
			{icon ? (
				<Ionicons name={icon} size={18} color={color || colors.text} />
			) : null}
			<Text style={[styles.itemText, color ? { color } : null]}>{label}</Text>
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	backdrop: {
		...StyleSheet.absoluteFillObject,
		backgroundColor: "rgba(0,0,0,0.6)",
	},
	sheet: {
		position: "absolute",
		left: 0,
		right: 0,
		bottom: 0,
		backgroundColor: colors.panel,
		borderTopLeftRadius: 16,
		borderTopRightRadius: 16,
		borderTopWidth: 2,
		borderLeftWidth: 2,
		borderRightWidth: 2,
		borderColor: colors.borderStrong,
		paddingHorizontal: 16,
	},
	grabZone: {
		paddingTop: 14,
		paddingBottom: 14,
	},
	handle: {
		alignSelf: "center",
		width: 56,
		height: 6,
		borderRadius: 3,
		backgroundColor: colors.borderStrong,
		marginBottom: 12,
	},
	title: {
		color: colors.accent,
		fontFamily: MONO,
		fontSize: 15,
		fontWeight: "700",
	},
	subtitle: {
		color: colors.muted,
		fontFamily: MONO,
		fontSize: 11,
		marginTop: 2,
	},
	item: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingVertical: 15,
		borderTopWidth: 1,
		borderTopColor: colors.border,
	},
	itemText: {
		color: colors.text,
		fontFamily: MONO,
		fontSize: 14,
		fontWeight: "700",
	},
});
