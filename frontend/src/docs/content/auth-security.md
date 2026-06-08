# Auth & Security

Authentication is handled by the `auth` app. Every protected handler takes an
`AuthenticatedUser` extractor (an Actix `FromRequest`) as a parameter — adding it
is what makes a route require auth.

## Two credential types

`AuthenticatedUser` resolves from **either**:

- **JWT Bearer** (RS256) — the normal interactive session token, or
- **API key** — a generated key for programmatic access, sent in a request header.

## JWT + refresh flow

Access tokens are short-lived; a refresh token mints new ones. On the web, the
axios interceptor in `frontend/src/api/axiosInstance.js` transparently handles
`401 → refresh → retry`, queuing concurrent requests during a refresh and
redirecting to login if no refresh token is present.

JWT signing keys resolve from configuration; if unset, the dev keys in
`rust/src/keys/` are used. The build auto-generates a key pair when the files are
missing, or you can run `generate_keys.py`.

## Permissions model

Permissions are **string-matched**. A user, group, or key carries a set of
permission strings, and handlers check for the ones they need. The special
**`admin_access`** permission **bypasses all checks**. Users, groups, and
permissions are related many-to-many.

## Two-factor authentication (TOTP)

2FA is implemented in `auth/otp.rs` using TOTP. A user can enroll (scanning a
secret into an authenticator app), confirm enrollment with a code, and later
disable it. Once enabled, login requires the time-based code as a second factor.
Backup codes are issued for recovery.

## Trusted devices

After a successful 2FA login a device can be marked trusted, letting it skip OTP
on return for a limited window (~30 days on mobile). Trusted devices can be listed
and revoked from account settings.

## Rate limiting

`auth/rate_limit.rs` provides a process-wide rate limiter (shared across Actix
workers) that throttles auth attempts to blunt brute-force and credential-stuffing.

## Account flows

The auth app also covers registration, login, token refresh, fetching and updating
the current profile, email verification, and password reset. Passwords are hashed
with **argon2**; verification and reset tokens are single-use and time-limited.
