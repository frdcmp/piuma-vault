import { StyleSheet, View } from 'react-native';

// Static cute-pixel-dog avatar — head + body from the running sprite,
// frozen in a standing pose. Used as the assistant chat avatar.
const SPRITE = [
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
  '...B.B...B.B....',
  '...B.B...B.B....',
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

export default function PiumaAvatar({ pixelSize = 2 }) {
  return (
    <View style={styles.wrap}>
      {SPRITE.map((row, r) => (
        <View key={r} style={styles.row}>
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

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  row: { flexDirection: 'row' },
});
