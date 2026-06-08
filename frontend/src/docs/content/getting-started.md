# Getting Started

This page covers running the full stack locally and the day-to-day developer
workflow.

## Prerequisites

- Docker + Docker Compose
- [Bun](https://bun.sh) (front-end package manager — never npm)
- A Rust toolchain (only needed for `cargo check`; builds run inside Docker)

## Running the stack

The `docker-compose.yml` defines two profiles: `server-stack` (nginx + rust +
embedding worker) and `db-stack` (PostgreSQL).

```bash
# Full stack (nginx + rust + worker + db)
docker compose --profile server-stack --profile db-stack up -d

# Rust hot-reload + nginx only (point at an external DB)
docker compose --profile server-stack up

# Tail backend logs
docker compose logs -f rust
```

The Rust services run under `cargo watch`, so they hot-reload on source changes.
**Never run `cargo build` or `docker compose build` for the backend** — to check
your Rust compiles, run:

```bash
cd rust && cargo check
```

## Front-end dev server

```bash
cd frontend
bun install
bun run dev      # Vite on :3000, proxies /api to the nginx port
```

Other scripts: `bun run build`, `bun run lint` (Biome), `bun run format`,
`bun run preview`.

## Reaching the backend

Nginx proxies everything and adds the `/api/v1/` prefix. With the default
`NGINX_PORT=8034` and `BASE_URL=/`:

```bash
curl http://localhost:8034/api/v1/health
```

The Vite dev server on `:3000` proxies `/api` to the same nginx port.

## Environment variables

All configuration lives in `.env` (gitignored); `.env.example` is the annotated
reference. Variables are grouped by concern:

| Group | Examples (names only) |
|---|---|
| Compose | `COMPOSE_NAME`, `NGINX_PORT`, `BASE_URL` |
| Server / CORS | `BACKEND_*`, CORS allow-list settings |
| Database | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (or `DATABASE_URL`) |
| SMTP | `EMAIL_*` |
| Object storage | `BUNNY_*` |
| JWT / OTP | `JWT_PRIVATE_KEY_PEM(_PATH)`, `JWT_PUBLIC_KEY_PEM(_PATH)`, OTP settings |

> Azure OpenAI and the LLM chat providers are **not** env vars — they are
> configured at runtime in the database via the admin **Services** and **Agents**
> dashboards. See **Admin Panel**.

`COMPOSE_NAME` namespaces the container names and the nginx → rust proxy target.

## Critical workflow rules

These conventions keep the codebase consistent:

1. **Backend**: use `cargo check`, never `cargo build` / `docker compose build`.
2. **Front-end package manager**: always `bun`, never npm.
3. **Formatting/lint**: run Biome on every modified front-end file
   (`bunx biome check --write src/<file>`).
4. **Build check**: after a long front-end change, run `bun run build`.
5. **Data fetching**: use the TanStack Query hooks in `frontend/src/queries`
   (import from the `@/queries` barrel), not raw API calls in components.
6. **Date/time display**: always use `frontend/src/utils/dateTime.js`
   (`formatDate`, `formatTime`, `formatDateTime`, `timeAgo`) — it converts UTC
   backend values to the browser timezone. Never use raw `toLocaleString()` etc.
