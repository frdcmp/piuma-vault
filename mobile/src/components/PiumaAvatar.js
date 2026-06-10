import { StyleSheet, View } from 'react-native';
import { PIUMA_SPRITE } from '../sprites/piuma';
import PiumaSprite from '../sprites/PiumaSprite';

// Static cute-pixel-dog avatar, frozen in a standing pose. Used as the
// assistant chat avatar.
export default function PiumaAvatar({ pixelSize = 2 }) {
  return (
    <View style={styles.wrap}>
      <PiumaSprite rows={PIUMA_SPRITE} pixelSize={pixelSize} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
});
