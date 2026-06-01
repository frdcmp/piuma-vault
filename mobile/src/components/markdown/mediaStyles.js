import { StyleSheet } from 'react-native';
import { colors } from '../../utils/theme';

// Shared styles for the attachment "view" components (image / video / audio /
// pdf / generic box). Kept in one place so every renderer matches.
export const mediaStyles = StyleSheet.create({
  imageWrap: { marginVertical: 8 },
  image: { width: '100%', borderRadius: 6, backgroundColor: colors.bgSoft },
  video: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 6,
    backgroundColor: '#000',
    marginVertical: 8,
  },
  // Generic file / audio box.
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.bgSoft,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginVertical: 8,
  },
  boxIcon: { fontSize: 22, marginRight: 12 },
  boxInfo: { flex: 1 },
  boxName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  boxHint: { color: colors.muted, fontSize: 12, marginTop: 2 },
  // PDF viewer.
  pdfWrap: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    overflow: 'hidden',
    marginVertical: 8,
    backgroundColor: colors.bgSoft,
  },
  pdf: { height: 480, backgroundColor: 'transparent' },
  pdfBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.panel,
  },
  pdfBarText: { color: colors.muted, fontSize: 12, flex: 1, marginRight: 8 },
  pdfOpen: { color: colors.accent4, fontSize: 12, fontWeight: '700' },
});
