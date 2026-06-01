@AGENTS.md

## EAS build commands

Run from the `mobile/` directory.

- APK (internal/preview testing):
  ```bash
  eas build --platform android --profile preview
  ```
- APK with dev client (for use with `expo start`):
  ```bash
  eas build --platform android --profile development
  ```
- AAB (Play Store production submission):
  ```bash
  eas build --platform android --profile production
  ```
