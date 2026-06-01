import { useEffect, useState } from 'react';
import { Image, Linking, TouchableOpacity } from 'react-native';
import { widthFromUrl } from '../../utils/attachments';
import { mediaStyles } from './mediaStyles';

// Remote image rendered inline. Fetches the natural size to keep the aspect
// ratio (remote images otherwise collapse to zero height in React Native);
// falls back to a fixed height until that resolves. Tap to open full-size.
// Honors a `w` query param on the URL as the display width (capped to the
// container via maxWidth), preserving the natural form factor via aspectRatio.
export default function ImageBlock({ uri, alt }) {
  const [ratio, setRatio] = useState(null);
  useEffect(() => {
    let alive = true;
    Image.getSize(
      uri,
      (w, h) => {
        if (alive && w && h) setRatio(w / h);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [uri]);
  const stored = widthFromUrl(uri);
  const sizeStyle = {
    width: stored || '100%',
    maxWidth: '100%',
    ...(ratio ? { aspectRatio: ratio } : { height: 220 }),
  };
  return (
    <TouchableOpacity
      style={mediaStyles.imageWrap}
      activeOpacity={0.85}
      onPress={() => Linking.openURL(uri).catch(() => {})}
    >
      <Image
        source={{ uri }}
        style={[mediaStyles.image, sizeStyle]}
        resizeMode="contain"
        accessibilityLabel={alt || undefined}
      />
    </TouchableOpacity>
  );
}
