import { StyleSheet, View } from 'react-native';
import { useSprite } from './SpriteProvider';

// Presentational pixel grid for a single pose of the active mascot. `rows` is an
// array of equal-length pixel-code strings; renders rows of solid-color cells
// using the active mascot's palette. Stateless — animation lives in the caller.
export default function Sprite({ rows, pixelSize = 8 }) {
  const { spriteColor, ready } = useSprite();
  // Until the active mascot has actually resolved (or fallen back on error),
  // render nothing rather than flash the baked-in default and swap it out.
  if (!ready) return null;
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
