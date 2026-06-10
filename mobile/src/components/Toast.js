// Lightweight transient toast for mobile — the in-app message primitive that
// mirrors the web's `pvMessage`. Fire one from anywhere (no context / hooks
// / prop-drilling) via the imperative API:
//
//   import { toast } from "../components/Toast";
//   toast.success("Model switched to GPT-5");
//   toast.error("Couldn't save");
//   toast.info("…");
//
// A single <ToastHost /> mounted at the app root listens and renders the stack.

import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, mono as MONO } from "../utils/theme";

// Module-level pub/sub: callers `emit`, the mounted host subscribes.
let counter = 0;
const listeners = new Set();
const emit = (kind, message) => {
	if (!message) return;
	const item = { id: ++counter, kind, message: String(message) };
	for (const l of listeners) l(item);
};

export const toast = {
	success: (m) => emit("success", m),
	error: (m) => emit("error", m),
	info: (m) => emit("info", m),
};

const KIND_COLOR = {
	success: colors.accent2,
	error: colors.accent3,
	info: colors.accent4,
};
const DURATION = 2400; // ms a toast stays before fading out
const MAX_VISIBLE = 3;

function ToastItem({ item, onDone }) {
	const anim = useRef(new Animated.Value(0)).current;
	useEffect(() => {
		Animated.timing(anim, {
			toValue: 1,
			duration: 160,
			useNativeDriver: true,
		}).start();
		const t = setTimeout(() => {
			Animated.timing(anim, {
				toValue: 0,
				duration: 200,
				useNativeDriver: true,
			}).start(() => onDone(item.id));
		}, DURATION);
		return () => clearTimeout(t);
	}, [anim, item.id, onDone]);

	const color = KIND_COLOR[item.kind] || colors.accent2;
	return (
		<Animated.View
			style={[
				styles.toast,
				{
					borderColor: color,
					opacity: anim,
					transform: [
						{
							translateY: anim.interpolate({
								inputRange: [0, 1],
								outputRange: [-8, 0],
							}),
						},
					],
				},
			]}
		>
			<Text style={[styles.text, { color }]} numberOfLines={2}>
				{item.message}
			</Text>
		</Animated.View>
	);
}

export default function ToastHost() {
	const insets = useSafeAreaInsets();
	const [items, setItems] = useState([]);

	useEffect(() => {
		const add = (item) =>
			setItems((cur) => [...cur, item].slice(-MAX_VISIBLE));
		listeners.add(add);
		return () => listeners.delete(add);
	}, []);

	const remove = useCallback(
		(id) => setItems((cur) => cur.filter((t) => t.id !== id)),
		[],
	);

	if (!items.length) return null;
	return (
		// pointerEvents none → toasts never intercept taps on the UI beneath.
		<View pointerEvents="none" style={[styles.host, { top: insets.top + 8 }]}>
			{items.map((it) => (
				<ToastItem key={it.id} item={it} onDone={remove} />
			))}
		</View>
	);
}

const styles = StyleSheet.create({
	host: {
		position: "absolute",
		left: 12,
		right: 12,
		alignItems: "center",
		zIndex: 1000,
		elevation: 1000,
	},
	toast: {
		maxWidth: 480,
		marginBottom: 6,
		paddingVertical: 8,
		paddingHorizontal: 12,
		borderWidth: 1,
		borderRadius: 4,
		backgroundColor: colors.bgSoft,
	},
	text: {
		fontFamily: MONO,
		fontSize: 12,
		textAlign: "center",
	},
});
