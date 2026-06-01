import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { attachmentMeta } from '../../utils/attachments';
import { mediaStyles } from './mediaStyles';

// Generic attachment shown as a tappable box (icon + filename). Opens the file
// URL in the browser / a suitable app. Also the fallback for media types whose
// native viewer module isn't bundled in the current build.
export default function FileBox({ url, label, hint }) {
  const meta = attachmentMeta(url);
  return (
    <TouchableOpacity
      style={mediaStyles.box}
      activeOpacity={0.7}
      onPress={() => Linking.openURL(url).catch(() => {})}
    >
      <Text style={mediaStyles.boxIcon}>{meta.icon}</Text>
      <View style={mediaStyles.boxInfo}>
        <Text style={mediaStyles.boxName} numberOfLines={1}>
          {label}
        </Text>
        <Text style={mediaStyles.boxHint}>{hint || `${meta.category} · tap to open`}</Text>
      </View>
    </TouchableOpacity>
  );
}
