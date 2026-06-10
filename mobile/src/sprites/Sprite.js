import { StyleSheet, View } from 'react-native';
import { spriteColor } from './index';

// Presentational pixel grid for a single pose of the active mascot. `rows` is an
// array of equal-length pixel-code strings (see ./index.js); renders rows of
// solid-color cells. Stateless — animation lives in the caller.
export default function Sprite({ rows, pixelSize = 8 }) {
  return (
    <View>
      {rows.map((row, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static sprite rows never reorder
        <View key={`row-${r}`} style={styles.row}>
          {row.split('').map((code, c) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: static sprite cells never reorder
              key={`px-${r}-${c}`}
              style={{
                width: pixelSize,
                height: pixelSize,
                backgroundColor: spriteColor(code),
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
});
