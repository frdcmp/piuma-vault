import { useEffect, useState } from 'react';
import { Dimensions, Platform, StyleSheet, Text, View } from 'react-native';
import PiumaRunning from '../components/PiumaRunning';
import PixelStarfield from '../components/PixelStarfield';
import { colors } from '../utils/theme';

function LoadingDots() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((v) => (v + 1) % 4), 350);
    return () => clearInterval(id);
  }, []);
  return <Text style={styles.dots}>{'.'.repeat(n)}</Text>;
}

export default function SplashScreen() {
  // Track the live window size so we cover the full viewport even when the
  // browser resizes / the device rotates.
  const [dims, setDims] = useState(() => Dimensions.get('window'));
  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => setDims(window));
    return () => sub?.remove();
  }, []);

  // On web, position:'fixed' lifts the splash out of any constrained parent
  // and pins it to the viewport so it can't be cropped by ancestor layouts.
  // On native, position:'absolute' with explicit window dimensions does the
  // same thing relative to the screen.
  const fullscreen =
    Platform.OS === 'web'
      ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }
      : { position: 'absolute', top: 0, left: 0, width: dims.width, height: dims.height };

  return (
    <View style={[styles.container, fullscreen]}>
      <PixelStarfield width={dims.width} height={dims.height} />
      <PiumaRunning pixelSize={10} />
      <View style={styles.labelWrap}>
        <Text style={styles.label}>Fetching your vault</Text>
        <LoadingDots />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 32,
    zIndex: 9999,
  },
  labelWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 22,
  },
  label: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  dots: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '600',
    minWidth: 24,
  },
});
