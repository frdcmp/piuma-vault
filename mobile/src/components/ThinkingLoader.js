import { useEffect, useRef } from 'react';
import { Animated, Platform, StyleSheet, Text, View } from 'react-native';
import SpriteAvatar from './SpriteAvatar';
import { colors } from '../utils/theme';

const MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

function Dot({ delay }) {
  const y = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(y, {
            toValue: -4,
            duration: 280,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: 280,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(y, {
            toValue: 0,
            duration: 280,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0.45,
            duration: 280,
            useNativeDriver: true,
          }),
        ]),
      ]),
    );
    const start = setTimeout(() => loop.start(), delay);
    return () => {
      clearTimeout(start);
      loop.stop();
    };
  }, [delay, y, opacity]);

  return (
    <Animated.View
      style={[
        styles.dot,
        { transform: [{ translateY: y }], opacity },
      ]}
    />
  );
}

export default function ThinkingLoader({ label = 'piuma is sniffing the trail' }) {
  return (
    <View style={styles.row}>
      <View style={styles.avatarBox}>
        <SpriteAvatar pixelSize={2} />
      </View>
      <View style={styles.body}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.dots}>
          <Dot delay={0} />
          <Dot delay={160} />
          <Dot delay={320} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minWidth: 220,
    marginTop: 4,
  },
  avatarBox: {
    borderWidth: 1,
    borderColor: 'rgba(131, 255, 146, 0.42)',
    backgroundColor: 'rgba(131, 255, 146, 0.08)',
    padding: 2,
  },
  body: { gap: 6 },
  label: {
    color: colors.muted,
    fontFamily: MONO,
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 0.4,
  },
  dots: { flexDirection: 'row', gap: 5 },
  dot: {
    width: 6,
    height: 6,
    backgroundColor: colors.accent,
  },
});
