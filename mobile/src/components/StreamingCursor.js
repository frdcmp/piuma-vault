import { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { colors } from '../utils/theme';

// Blinking green pixel block rendered at the end of a streaming assistant
// message — same vibe as the frontend's .creepChatMarkdown__cursor.
export default function StreamingCursor() {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 450,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 450,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return <Animated.View style={[styles.cursor, { opacity }]} />;
}

const styles = StyleSheet.create({
  cursor: {
    width: 10,
    height: 18,
    backgroundColor: colors.accent2,
    marginTop: 4,
  },
});
