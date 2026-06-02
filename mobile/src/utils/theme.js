import { Platform } from 'react-native';

// Token palette mirrored from frontend NotesSidebar.css so mobile and web
// share the same look.
export const colors = {
  bg: '#0e0f12',
  bgSoft: '#15171c',
  panel: '#1b1e25',
  border: '#2a2f3a',
  borderStrong: '#3a4150',
  text: '#d6dbe5',
  muted: '#8a93a3',
  accent: '#f7c948',
  accent2: '#5cd0a9',
  accent3: '#ff6b6b',
  accent4: '#6cb6ff',
};

// The pixel/terminal aesthetic is monospace + hard square edges. Shared here so
// every component renders the same way instead of redefining MONO locally.
export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});
