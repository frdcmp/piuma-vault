import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import PiumaRunning from './PiumaRunning';
import PixelStarfield from './PixelStarfield';
import { colors } from '../utils/theme';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function LoadingDots() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((v) => (v + 1) % 4), 350);
    return () => clearInterval(id);
  }, []);
  return <Text style={styles.dots}>{'.'.repeat(n)}</Text>;
}

export default function PiumaLoader({ message = 'Loading', pixelSize = 8 }) {
  const [dims, setDims] = useState({ width: 0, height: 0 });
  return (
    <View
      style={styles.container}
      onLayout={(e) => setDims(e.nativeEvent.layout)}
    >
      {dims.width > 0 && (
        <PixelStarfield width={dims.width} height={dims.height} />
      )}
      <PiumaRunning pixelSize={pixelSize} />
      {message ? (
        <View style={styles.labelWrap}>
          <Text style={styles.label}>{message}</Text>
          <LoadingDots />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    backgroundColor: colors.bg,
  },
  labelWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 20,
  },
  label: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: MONO,
    letterSpacing: 0.5,
  },
  dots: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: MONO,
    minWidth: 22,
  },
});
