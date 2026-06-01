import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors } from '../utils/theme';

// Deterministic PRNG so the star pattern is stable across re-renders
// (no jumping during animation) but still feels random.
function makeRand(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Tiny pixel-art moon in the upper area.
const MOON = [
  '..####..',
  '.######.',
  '########',
  '########',
  '########',
  '########',
  '.######.',
  '..####..',
];

function PixelMoon({ x, y, pixelSize = 3 }) {
  return (
    <View style={{ position: 'absolute', left: x, top: y }}>
      {MOON.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row' }}>
          {row.split('').map((c, i) => (
            <View
              key={i}
              style={{
                width: pixelSize,
                height: pixelSize,
                backgroundColor: c === '#' ? '#f7e9b0' : 'transparent',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

export default function PixelStarfield({ width, height }) {
  const { stars, moon } = useMemo(() => {
    const rand = makeRand(20251);
    const list = [];
    // Density scales with viewport area so a wide screen still feels starry.
    const count = Math.max(50, Math.floor((width * height) / 9000));
    for (let i = 0; i < count; i++) {
      const r = rand();
      list.push({
        x: Math.floor(rand() * width),
        y: Math.floor(rand() * height),
        size: r > 0.92 ? 3 : r > 0.65 ? 2 : 1,
        bright: r > 0.85,
      });
    }
    // Place moon in the upper-right quadrant, well away from the centred dog.
    const moonPos = {
      x: Math.floor(width * 0.78),
      y: Math.floor(height * 0.18),
    };
    return { stars: list, moon: moonPos };
  }, [width, height]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {stars.map((s, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: s.x,
            top: s.y,
            width: s.size,
            height: s.size,
            backgroundColor: s.bright ? colors.accent : colors.text,
            opacity: s.bright ? 0.9 : 0.5,
          }}
        />
      ))}
      <PixelMoon x={moon.x} y={moon.y} pixelSize={3} />
    </View>
  );
}
