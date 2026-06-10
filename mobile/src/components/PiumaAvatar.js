import { StyleSheet, View } from 'react-native';
import { Sprite, useSprite } from '../sprites';

// Static mascot avatar, frozen in a standing pose. Used as the assistant chat
// avatar.
export default function PiumaAvatar({ pixelSize = 2 }) {
  const { sprite } = useSprite();
  return (
    <View style={styles.wrap}>
      <Sprite rows={sprite} pixelSize={pixelSize} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
});
