import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { BODY, GALLOP_FRAME_MS, GALLOP_LEGS, Sprite } from '../sprites';

const BOUNCE_MS = 280; // one full bob = two leg frames

export default function PiumaRunning({ pixelSize = 10 }) {
  const [frame, setFrame] = useState(0);
  const bounce = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % GALLOP_LEGS.length);
    }, GALLOP_FRAME_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bounce, {
          toValue: 1,
          duration: BOUNCE_MS / 2,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(bounce, {
          toValue: 0,
          duration: BOUNCE_MS / 2,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [bounce]);

  const translateY = bounce.interpolate({ inputRange: [0, 1], outputRange: [0, -pixelSize / 2] });
  const rotate = bounce.interpolate({ inputRange: [0, 1], outputRange: ['-2deg', '2deg'] });

  const rows = [...BODY, ...GALLOP_LEGS[frame]];

  return (
    <Animated.View style={[styles.wrap, { transform: [{ translateY }, { rotate }] }]}>
      <Sprite rows={rows} pixelSize={pixelSize} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
});
