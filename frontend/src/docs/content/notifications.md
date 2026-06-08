# Notifications & Alerts

Task and event alerts are delivered across channels — Web Push, mobile push, and
loud in-app alarms — by the `notifications` app plus a dedicated worker.

## How an alert becomes a notification

1. A task or calendar event with alerts materializes entries into a scheduled-alert
   queue.
2. A **notification worker** polls that queue for due alerts.
3. Due alerts fan out to each enabled channel for the user.

## Channels

### Web Push (VAPID)

The browser subscribes with the server's VAPID public key; subscriptions are stored
server-side and can be removed. The web client subscribes via
`frontend/src/utils/webPush.js`.

### Mobile push

The mobile app registers its push token on launch (and unregisters on sign-out),
so alerts reach the device through the platform push service.

### In-app alarms

When an alert fires while the app is open, a loud, must-dismiss alarm rings:

- **Web** — `AlarmHost` (mounted at the app root) plays an alarm sound.
- **Mobile** — a full-screen Notifee intent wakes the screen over the lock screen;
  `AlarmModal` owns the looping sound. Remote and local deliveries are **de-duped by
  tag** so an alarm never double-rings.

## Preferences and testing

Per-channel preferences (web / push enabled) can be read and updated, a test
notification can be sent, and upcoming due alerts can be previewed. Enabling push
requires the appropriate VAPID setup on the web and notification permission on
mobile.
