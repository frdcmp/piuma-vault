# Admin Panel

The admin panel lives under `/admin/*` in the web app, behind a layout that checks
the `admin_access` permission. It is where the vault is configured and operated.

## Services

The **Services** dashboard configures the external services that are **not** env
vars, with a test button for each:

- **Embeddings** — Azure OpenAI endpoint / key / deployment
- **Chat gateway** — the external LLM chat gateway
- **Storage** — the S3-compatible store and CDN host
- **Web search** — the active search provider

Storing these settings in the database means they can be changed at runtime without
a redeploy.

## API keys

Generate scoped keys for programmatic access. Keys carry scoped permissions (e.g.
notes read/write, storage, tasks, calendar) and an optional expiry, and can be
revoked.

## Database backups

Create, download, delete, and restore database dumps from the **Backups** page.

## Health records

A small CRUD surface used for health-tracking entries, plus a liveness check that
doubles as the canonical "is the API up" probe.

## Profile & settings

The **Profile** page manages account details, avatar, notification preferences, and
language/timezone. **Settings** holds security-focused options (password, 2FA,
trusted devices). Both read through the auth/user layer described in
**Auth & Security**.
