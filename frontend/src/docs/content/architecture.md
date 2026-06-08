# System Architecture

The backend lives in `rust/` and is built on Actix-web 4 + sqlx 0.8 (compile-time
checked SQL, no ORM) + tokio.

## Two binaries

`Cargo.toml` declares `default-run = "backend"` and ships two binaries that share
code through the `backend` library (`src/lib.rs` re-exports `db` and `apps`):

- **`backend`** — the HTTP API.
- **`embedding-worker`** — generates embeddings in the background for both notes
  and agent **memory entries**. It claims pending work atomically (so multiple
  workers never double-process), calls Azure OpenAI to produce the vectors, stores
  them on the row, and marks the job done. See **[Agent Memory](/docs/agent-memory)**.

## No `/api/v1/` prefix in code

Nginx adds the `/api/v1/` prefix at the edge. Routes are registered **relative** in
code — externally everything is reached under `/api/v1/...`.

## The app-module pattern

Every feature is a directory under `src/apps/{feature}/` that follows the same
shape:

```
src/apps/notes/
├── mod.rs        # re-exports
├── models.rs     # serializable / row-mapped structs
├── handlers.rs   # async request handlers
├── routes.rs     # pub fn configure_routes(cfg: &mut web::ServiceConfig)
├── events.rs     # (optional) SSE event bus
└── middleware.rs # (optional)
```

To add a feature, follow this layout and register its `configure_routes` at
startup. Existing apps include health, auth (with OTP, rate limiting, RSA keys),
email, agents (chat gateway, providers, tools), API keys, notes, tasks, calendar,
buckets, agenda, notifications, shares, storage, settings, and database backups.

## Bootstrap

On boot the backend:

1. Builds the sqlx connection pool from configuration.
2. Ensures the schema exists (see below).
3. Injects shared state: the connection pool, the rate limiter, the SSE event
   buses (notes / tasks / calendar), and the agent turn-control plane.
4. Wraps CORS and a request logger.
5. Chains each app's route configuration.

It is tuned for concurrency (worker count scales with CPUs, with generous backlog
and connection limits).

## Schema management (no migrations)

There is **no migrations framework**. The schema is created on boot from a
declarative definition (create-if-not-exists). This means:

- To change an existing structure (alter / drop / backfill), run **ad-hoc SQL**
  against the database, then update the declarative definition so a fresh boot
  matches production. There is no `migrations/` folder.
- Queries are raw, parameterized sqlx.

## Realtime SSE event buses

Cross-device live sync is built on a generic resource event bus. Each realtime
resource (notes, tasks, calendar) has its own bus that emits **Created / Updated /
Deleted** events.

The flow is deliberately simple:

1. A mutating handler publishes an event on the bus.
2. Clients hold a Server-Sent-Events connection to a stream endpoint.
3. On any event the client **re-fetches** through the normal read path — the SSE
   payload is a nudge, not the data.

Front-end hooks (`useNotesLiveUpdates`, `useTasksLiveUpdates`,
`useCalendarLiveUpdates`, `useTagsLiveUpdates`) and the mobile
`useResourceLiveUpdates` wrap this pattern.
