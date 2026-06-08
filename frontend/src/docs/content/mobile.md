# Mobile App

The companion app in `mobile/` is built with Expo / React Native. It targets the
same backend and mirrors the web feature set: notes, chat, tasks, calendar, and
storage, with offline caching, live sync, and push notifications.

> Before writing mobile code, read `mobile/CLAUDE.md` and `mobile/AGENTS.md` —
> the versioned docs there are authoritative.

## Screens & navigation

Navigation is a React Navigation native-stack (`src/navigation/AppNavigator.js`):

- **VaultHome** — the hub: a notes editor with two gesture-driven drawers (left =
  notes list, right = AI chat).
- **Chat** — full agent chat (streaming, tools, model/agent switch, slash commands).
- **Tasks** — draggable task list with priorities, recurrence, bucket/tag filters.
- **Calendar** — month / week / 3-day views with events, deadlines, and occurrences.
- **Storage** — file manager (browse, upload, rename/move/delete, share, zip).
- **Login** — email/password + OTP, with trusted-device support.
- **Splash** — minimum-duration splash while auth initializes.

## State, data, and offline

- **Zustand** holds auth and alarm state.
- **TanStack Query** holds server state, persisted to **AsyncStorage** so cached
  data rehydrates on cold start.
- Auth tokens are kept in **SecureStore** on device (AsyncStorage on web); the
  trusted-device token survives sign-out so it can be revoked deliberately.

There's no explicit offline editor — when online, lists stay fresh via SSE; when
offline, cached data is served and the next sync refetches.

## Live updates (SSE)

`src/queries/liveUpdates.js` provides `useResourceLiveUpdates` using
`react-native-sse` (React Native has no native `EventSource`). It:

- sends the auth token in a header (kept out of URLs/access logs),
- auto-reconnects with exponential backoff,
- refreshes the token on the first failure of an established session,
- and, on app foreground, refetches then reconnects (SSE is killed in background).

Notes, tasks, calendar, and tags all subscribe.

## Notifications & alarms

Remote delivery uses `expo-notifications`. Local full-screen alarms use **Notifee**
with a full-screen intent that wakes the screen over the lock screen; the two are
de-duped by tag. See **Notifications & Alerts**.

> Hermes lacks `Intl.RelativeTimeFormat`, so mobile date formatting uses **dayjs**,
> not `Intl` (using `Intl` crashes on Android).

## Builds & OTA updates

Builds run on **EAS** with three profiles:

- `development` → `.apk` with a dev client for `expo start` debugging
- `preview` → standalone `.apk` (distributed via storage + an update manifest)
- `production` → `.aab` for store submission

`build.sh` bumps the version, builds the APK, uploads it to storage, and publishes
an update manifest with the version, build time, and APK location. On open, the app
reads the manifest, compares versions (`appUpdate.js` `isNewer`), and the
`UpdatePrompt` component offers a one-tap download — an over-the-air APK update
channel independent of any app store.
