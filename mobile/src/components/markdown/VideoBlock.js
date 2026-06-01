import FileBox from './FileBox';
import { mediaStyles } from './mediaStyles';

// Optional native module — present only in a build that bundled expo-video
// (needs a native rebuild). Missing → fall back to the tap-to-open box.
let ExpoVideo = null;
try {
  ExpoVideo = require('expo-video');
} catch {
  ExpoVideo = null;
}

// Hooks live here so they're only mounted when the module is available.
function VideoPlayer({ uri }) {
  const player = ExpoVideo.useVideoPlayer(uri);
  return (
    <ExpoVideo.VideoView
      style={mediaStyles.video}
      player={player}
      nativeControls
      fullscreenOptions={{ enable: true }}
    />
  );
}

// Inline video with native transport controls (expo-video).
export default function VideoBlock({ url, label }) {
  if (!ExpoVideo) return <FileBox url={url} label={label} />;
  return <VideoPlayer uri={url} />;
}
