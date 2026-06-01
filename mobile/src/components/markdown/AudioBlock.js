import { Text, TouchableOpacity, View } from 'react-native';
import FileBox from './FileBox';
import { mediaStyles } from './mediaStyles';

// Optional native module — present only in a build that bundled expo-audio
// (needs a native rebuild). Missing → fall back to the tap-to-open box.
let ExpoAudio = null;
try {
  ExpoAudio = require('expo-audio');
} catch {
  ExpoAudio = null;
}

// Hooks live here so they're only mounted when the module is available.
function AudioPlayer({ uri, label }) {
  const player = ExpoAudio.useAudioPlayer(uri);
  const status = ExpoAudio.useAudioPlayerStatus(player);
  const playing = !!status?.playing;
  return (
    <TouchableOpacity
      style={mediaStyles.box}
      activeOpacity={0.7}
      onPress={() => (playing ? player.pause() : player.play())}
    >
      <Text style={mediaStyles.boxIcon}>{playing ? '⏸' : '▶️'}</Text>
      <View style={mediaStyles.boxInfo}>
        <Text style={mediaStyles.boxName} numberOfLines={1}>
          {label}
        </Text>
        <Text style={mediaStyles.boxHint}>audio · tap to {playing ? 'pause' : 'play'}</Text>
      </View>
    </TouchableOpacity>
  );
}

// Inline audio player: a play/pause box showing the filename (expo-audio).
export default function AudioBlock({ url, label }) {
  if (!ExpoAudio) return <FileBox url={url} label={label} />;
  return <AudioPlayer uri={url} label={label} />;
}
