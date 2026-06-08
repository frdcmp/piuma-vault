# Piuma Vault

Personal vault and website behind [vault.example.com](https://vault.example.com) — notes with vector
search, LLM chat, file storage, public note shares, and an admin panel, plus a companion Expo
mobile app.

## Stack

| Layer        | Tech                                                                 |
| ------------ | -------------------------------------------------------------------- |
| Frontend     | React 19, Vite 7, Ant Design 5, TanStack Query 5, zustand, Three.js  |
| Backend      | Rust, Actix-web 4, sqlx 0.8 (no ORM), tokio                          |
| Database     | PostgreSQL 15 + pgvector                                             |
| Proxy / edge | Nginx (adds `/api/v1/` prefix); TLS terminates at Cloudflare         |
| Mobile       | Expo / React Native (see [`mobile/`](mobile/))                       |
| Orchestration| Docker Compose (`server-stack` + `db-stack` profiles)               |

## Architecture

```
                 ┌─────────────┐
   Cloudflare ── │    nginx    │  serves frontend/dist, proxies /api/v1/ → rust:8080
   (TLS)         └──────┬──────┘
                        │
          ┌─────────────┼──────────────────┐
          │             │                  │
   ┌──────▼─────┐ ┌─────▼──────┐  ┌─────────▼─────────┐
   │  backend   │ │  postgres  │  │ embedding-worker  │
   │ (port 8080)│ │ + pgvector │  │ (polls jobs)      │
   └────────────┘ └────────────┘  └───────────────────┘
```

- **`backend`** (`rust/src/main.rs`) — the API. Routes register relative (e.g. `/admin/notes`);
  nginx adds the `/api/v1/` prefix at the edge. Auth is JWT (RS256) or `x-api-key`, both resolved
  through the `AuthenticatedUser` extractor; `admin_access` bypasses permission checks. 2FA via TOTP.
- **`embedding-worker`** (`rust/src/bin/embedding-worker.rs`) — polls the `embedding_jobs` table
  (`FOR UPDATE SKIP LOCKED`), calls Azure OpenAI to generate 1536-dim vectors, and stores them on
  `notes` for semantic search.
- **No migrations framework** — tables are created on boot (create-if-not-exists) by `db_init`.

Backend feature apps (`rust/src/apps/`): `health`, `auth`, `email`, `llm`, `api_keys`, `notes`,
`shares`, `storage`, `settings`.

## Getting started

### Prerequisites

- Docker + Docker Compose
- [Bun](https://bun.sh) (frontend), Rust toolchain (for local `cargo check`)

### Configure

```bash
cp .env.example .env
# fill in DB, SMTP, Bunny Storage, JWT/OTP values
```

> **Note:** Azure OpenAI (embeddings) and the LLM chat providers/models are **not** configured via
> env vars — they live in the database and are edited at runtime in the admin **Services** and
> **Agents** dashboards.

JWT signing keys are auto-generated into `rust/src/keys/` on first build (or run
`python generate_keys.py`). For production, supply your own via `JWT_PRIVATE_KEY_PEM` /
`JWT_PUBLIC_KEY_PEM` (or `*_PATH`).

### Run

```bash
# Full stack (nginx + rust + worker + db)
docker compose --profile server-stack --profile db-stack up -d

# Backend hot-reload + nginx only (rust runs under `cargo watch`)
docker compose --profile server-stack up

# Frontend dev server (outside Docker) — http://localhost:3000, proxies /api to nginx
cd frontend && bun install && bun run dev

# Logs
docker compose logs -f rust
```

With the defaults (`NGINX_PORT=8034`, `BASE_URL=/`), the API is reachable at
`http://localhost:8034/api/v1/health`.

## Development

```bash
# Backend — check without building (the container owns the build via cargo watch)
cd rust && cargo check

# Frontend
cd frontend
bun run dev          # dev server
bun run build        # production build → dist/ (gzip + brotli precompressed)
bun run lint         # biome check
bun run format       # biome format --write
```

Backend timestamps are UTC; the frontend renders them via `frontend/src/utils/dateTime.js`.

## Deployment

`./update_servers.sh` SSH-deploys to the configured remote host(s): pull, build the frontend, and
restart containers. Flags: `--pull-only`, `--compose-build`, `--full-update`.

## Layout

```
frontend/   React 19 + Vite web app
rust/        Actix-web backend (binaries: backend, embedding-worker)
mobile/      Expo / React Native app (see mobile/CLAUDE.md)
nginx/       default.conf.template (proxy, security headers, Cloudflare IP forwarding)
md/          docs, plans, RESUME.md
```

See [CLAUDE.md](CLAUDE.md) for detailed architecture and conventions.
