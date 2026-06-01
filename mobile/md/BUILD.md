# pv vault — Android APK Build Guide

Step-by-step instructions for building an Android APK (or AAB for Play Store) of the **pv vault** mobile app using Expo Application Services (EAS).

## Prerequisites

- Node.js and npm installed
- An Expo account (create one at https://expo.dev if you don't have one)
- This project's `app.json` (already configured) and an `eas.json` (see below — create if missing)

## Configuration files

### `app.json`

The app is configured with:
- **App name**: pv vault
- **Slug**: mobile
- **Version**: 1.0.0
- **Orientation**: portrait
- **Theme**: dark (`userInterfaceStyle: "dark"`)
- **Splash background**: `#5cd0a9` (matches the icon BG)
- **Adaptive icon**: foreground/background/monochrome in `./assets/`
- **Web favicon**: `./assets/favicon.png`

You'll need to add an Android `package` identifier before the first cloud build — pick something stable like `com.pv.vault`:

```json
"android": {
  "package": "com.pv.vault",
  "adaptiveIcon": { ... }
}
```

iOS users add a matching `ios.bundleIdentifier`.

### `eas.json`

Minimal `eas.json` for this project (create at `mobile/eas.json` if it isn't there yet):

```json
{
  "cli": { "version": ">= 5.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" }
    },
    "production": {
      "android": { "buildType": "app-bundle" }
    }
  },
  "submit": {
    "production": {}
  }
}
```

Build profiles:
- **development** — for `expo-dev-client` builds (debugging native modules)
- **preview** — internal testing, outputs `.apk` (side-loadable)
- **production** — Play Store release, outputs `.aab`

## Build process

### 1. Install EAS CLI

```bash
npm install -g eas-cli
```

### 2. Log in to Expo

```bash
eas login
eas whoami   # verify
```

### 3. Build the APK (preview profile)

From the `mobile/` directory:

```bash
cd ~/docker/pv/mobile
eas build --platform android --profile preview
```

What happens:
1. EAS asks if you want it to manage the Android keystore (say yes for the first build).
2. The project is uploaded to EAS Build.
3. A build URL is printed — track progress there.
4. Builds typically take 5–15 minutes.

#### Local build alternative

If Android SDK + JDK are installed locally:

```bash
eas build --platform android --profile preview --local
```

### 4. Download the APK

```bash
# Option A: open the URL printed by `eas build`
# Option B: CLI
eas build:list --platform android
eas build:download --platform android --id <BUILD_ID>
# Option C: latest
eas build:download --platform android --latest
```

### 5. Install on an Android device

**USB (adb):**
```bash
adb devices
adb install -r path/to/pv-vault.apk
```

**Direct on device:**
1. Transfer the APK to the device.
2. Open it.
3. Allow installation from unknown sources if prompted.

**QR code:** scan the QR on the EAS build page directly with the device.

## Build profiles explained

| Profile | Output | Use case |
|---|---|---|
| `development` | dev client APK | Native debugging |
| `preview` | `.apk` | Side-loading, internal testing |
| `production` | `.aab` | Play Store submission |

```bash
# Production AAB:
eas build --platform android --profile production
```

## Environment configuration

The app reads its API base URL from `EXPO_PUBLIC_API_URL` (see [src/api/axiosInstance.js](../src/api/axiosInstance.js)). Default falls back to `https://vault.example.com/api/v1`.

To override per build profile, add an `env` block:

```json
{
  "build": {
    "staging": {
      "distribution": "internal",
      "android": { "buildType": "apk" },
      "env": {
        "EXPO_PUBLIC_API_URL": "https://staging.example.com/api/v1"
      }
    }
  }
}
```

Then:
```bash
eas build --platform android --profile staging
```

## Troubleshooting

**"Not logged in"** — run `eas login`.

**"No Android credentials"** — choose "Let Expo handle the keystore" on first build, or upload your own.

**"Package name already in use"** — change `android.package` in `app.json` to a unique identifier.

**Local build requirements** — Android Studio + SDK, JDK 17 (Expo SDK 55), and `ANDROID_HOME` / `ANDROID_SDK_ROOT` env vars.

**Slow builds** — 5–15 min is normal on EAS free tier. Check the build URL.

**SecureStore / AsyncStorage on web** — handled in [src/stores/authStore.js](../src/stores/authStore.js); SecureStore is used on native, AsyncStorage on web (SecureStore isn't implemented on web in SDK 55).

## Versioning

Before each release:

1. Bump `version` in `app.json`:
   ```json
   "version": "1.0.1"
   ```
2. Increment `android.versionCode`:
   ```json
   "android": { "versionCode": 2 }
   ```
3. Rebuild.

## CI / CD (GitHub Actions example)

```yaml
name: EAS Build
on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
        working-directory: mobile
      - run: npm install -g eas-cli
      - run: eas build --platform android --profile preview --non-interactive
        working-directory: mobile
        env:
          EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
```

Get `EXPO_TOKEN` at https://expo.dev/accounts/<your-account>/settings/access-tokens.

## Quick reference

```bash
# Versions
eas --version
node -v

# Auth
eas login
eas logout
eas whoami

# Build
cd ~/docker/pv/mobile
eas build --platform android --profile preview      # APK
eas build --platform android --profile production   # AAB
eas build --platform android --profile development  # Dev client

# Inspect
eas build:list
eas build:view <BUILD_ID>
eas build:download --platform android --latest
eas build:cancel <BUILD_ID>

# Native project regeneration (rarely needed)
cd ~/docker/pv/mobile
rm -rf android
eas build --platform android --profile preview
```

## Additional resources

- EAS Build docs: https://docs.expo.dev/build/introduction/
- EAS CLI reference: https://docs.expo.dev/eas/cli/
- Expo SDK 55 release notes: https://docs.expo.dev/versions/v55.0.0/
- Submit to Play Store: https://docs.expo.dev/submit/android/

---

**Project**: pv vault (mobile)
**App version**: 1.0.0
**Build system**: Expo Application Services (EAS), Expo SDK 55
**Contact**: user@example.com
