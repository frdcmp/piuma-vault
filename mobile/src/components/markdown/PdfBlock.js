import { Linking, Platform, Text, TouchableOpacity, View } from 'react-native';
import FileBox from './FileBox';
import { mediaStyles } from './mediaStyles';

// Optional native module — present only in a build that bundled
// react-native-webview (needs a native rebuild). Missing → fall back to box.
let WebView = null;
try {
  ({ WebView } = require('react-native-webview'));
} catch {
  WebView = null;
}

// Inline PDF viewer. iOS WebView renders PDFs natively; Android WebView can't,
// so we route it through Google's embedded viewer (our note PDFs are on the
// public CDN prefix, so this is fine). A footer bar opens it externally.
export default function PdfBlock({ url, label }) {
  if (!WebView) return <FileBox url={url} label={label} />;
  const source =
    Platform.OS === 'android'
      ? `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(url)}`
      : url;
  return (
    <View style={mediaStyles.pdfWrap}>
      <WebView
        style={mediaStyles.pdf}
        source={{ uri: source }}
        originWhitelist={['*']}
        startInLoadingState
        scalesPageToFit
      />
      <TouchableOpacity
        style={mediaStyles.pdfBar}
        activeOpacity={0.7}
        onPress={() => Linking.openURL(url).catch(() => {})}
      >
        <Text style={mediaStyles.pdfBarText} numberOfLines={1}>
          📕 {label}
        </Text>
        <Text style={mediaStyles.pdfOpen}>OPEN</Text>
      </TouchableOpacity>
    </View>
  );
}
