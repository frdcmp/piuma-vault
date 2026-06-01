import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

// Shared body rows for every run frame — only the legs change.
const BODY = [
  '................',
  '.....EEBB.......',
  '....EBBBBB......',
  '...BBBBBBBB.....',
  '...BBYBBYBB.BBB.',
  '...BMMNMMBBBBBB.',
  '...BBMTMBBBBBBB.',
  '...CCCCCCCCCCC..',
  '...BWWWWWWWWBB..',
  '...BWWWWWWWWBB..',
];

// Two-frame gallop cycle:
//   A — front legs reach forward, back legs push off behind
//   B — front legs land back, back legs gather forward
const RUN_LEGS = [
  [
    '..B.B.....B.B...',
    '..B.B.......B.B.',
  ],
  [
    '....B.B...B.B...',
    '....B.B..B.B....',
  ],
];

const PALETTE = {
  B: '#ad7549',
  W: '#f5f5f5',
  M: '#f5f5f5',
  E: '#0d0d0d',
  N: '#000000',
  Y: '#090909',
  T: '#ff7a9a',
  C: '#c0392b',
};

const FRAME_MS = 140;
const BOUNCE_MS = 280; // one full bob = two leg frames

function Sprite({ rows, pixelSize }) {
  return (
    <View>
      {rows.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row' }}>
          {row.split('').map((code, c) => (
            <View
              key={c}
              style={{
                width: pixelSize,
                height: pixelSize,
                backgroundColor: PALETTE[code] || 'transparent',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

export default function PiumaRunning({ pixelSize = 10 }) {
  const [frame, setFrame] = useState(0);
  const bounce = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % RUN_LEGS.length);
    }, FRAME_MS);
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

  const rows = [...BODY, ...RUN_LEGS[frame]];

  return (
    <Animated.View style={[styles.wrap, { transform: [{ translateY }, { rotate }] }]}>
      <Sprite rows={rows} pixelSize={pixelSize} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
});
