import { StyleSheet, View } from 'react-native';
import { Sprite, SPRITE } from '../sprites';

// Static cute-pixel-dog avatar, frozen in a standing pose. Used as the
// assistant chat avatar.
export default function PiumaAvatar({ pixelSize = 2 }) {
  return (
    <View style={styles.wrap}>
      <Sprite rows={SPRITE} pixelSize={pixelSize} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
});
