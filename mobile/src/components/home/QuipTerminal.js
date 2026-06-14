import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text } from "react-native";
import { colors, mono } from "../../utils/theme";

// Quips reference the active mascot by name.
const makeQuips = (name) => [
	`Pick a note, or ${name} keeps floating...`,
	`Nothing selected. ${name} is judging you.`,
	`Empty. ${name} fetched a whole lot of nothing.`,
	`No note open — ${name}'s getting dizzy up here.`,
	`Go on, click something. ${name} dares you.`,
	`404: note not selected. ${name} shrugs.`,
];

// Terminal-style typewriter line with a blinking caret. Self-contained so any
// menu variant can drop it in.
export default function QuipTerminal({ name, style }) {
	const caret = useRef(new Animated.Value(1)).current;
	const [typed, setTyped] = useState("");

	// Type a quip char by char, hold, backspace it, advance. One recursive
	// timeout chain so speeds stay independent of React's render cadence.
	useEffect(() => {
		const QUIPS = makeQuips(name);
		const TYPE_MS = 55;
		const DELETE_MS = 25;
		const HOLD_MS = 2400;
		const GAP_MS = 500;
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
	}, [name]);

	// Hard 1s blink trailing the text.
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

	return (
		<Text style={[styles.text, style]}>
			{typed}
			<Animated.Text style={[styles.caret, { opacity: caret }]}>
				▋
			</Animated.Text>
		</Text>
	);
}

const styles = StyleSheet.create({
	text: {
		color: colors.muted,
		fontSize: 14,
		fontWeight: "600",
		letterSpacing: 0.3,
		lineHeight: 22,
		textAlign: "center",
		fontFamily: mono,
		maxWidth: 240,
		minHeight: 44,
	},
	caret: {
		color: colors.accent,
		fontFamily: mono,
		fontSize: 14,
	},
});
