import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable } from "react-native";
import { Sprite, useSprite } from "../../sprites";

// The drop-in + idle-bob + tap-to-hop mascot, extracted so every home-menu
// variant can place Bubu wherever its layout wants (centered sun, floating
// header, dial hub, ...) while sharing one animation implementation.
export default function FloatingMascot({
	pixelSize = 8,
	name = "Bubu",
	onTap,
}) {
	const { sprite } = useSprite();
	// fall: entrance drop from above. float: idle bob after landing.
	const fall = useRef(new Animated.Value(-400)).current;
	const float = useRef(new Animated.Value(0)).current;
	// jump: one-shot hop played on tap (0 = grounded).
	const jump = useRef(new Animated.Value(0)).current;

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

	const floatY = float.interpolate({
		inputRange: [0, 1],
		outputRange: [0, -8],
	});
	const rotate = float.interpolate({
		inputRange: [0, 1],
		outputRange: ["-3deg", "3deg"],
	});
	const jumpY = jump.interpolate({ inputRange: [0, 1], outputRange: [0, -40] });

	// Quick up-and-down hop. Ignores taps while already mid-jump.
	const boop = () => {
		onTap?.();
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
		<Pressable onPress={boop} accessibilityLabel={`Boop ${name}`}>
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
				<Sprite rows={sprite} pixelSize={pixelSize} />
			</Animated.View>
		</Pressable>
	);
}
