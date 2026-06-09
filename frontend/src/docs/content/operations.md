# Operations & Deployment

How the stack is orchestrated, deployed, and maintained.

## Docker Compose

Services are defined in `docker-compose.yml` with two profiles:

- **`server-stack`** — nginx, the Rust `backend`, and the `embedding-worker`.
- **`db-stack`** — PostgreSQL 15 + pgvector.

```bash
docker compose --profile server-stack --profile db-stack up -d   # everything
docker compose --profile server-stack up                          # app only
docker compose logs -f rust                                       # logs
```

`COMPOSE_NAME` namespaces container names and the nginx → rust proxy target, so
multiple stacks can coexist on one host.

## Nginx edge

`nginx/default.conf.template` adds the `/api/v1/` prefix, sets security headers, and
forwards the Cloudflare connecting-IP header so the backend sees the real client IP.
TLS terminates at Cloudflare; the origin serves plain HTTP.

## Deploying

Deployments are typically run via Docker Compose on the host machine. The Rust services run under hot-reload or production profiles in their containers — so a deploy is largely a `git pull` followed by a container restart:

```bash
docker compose pull && docker compose up -d
```

## JWT keys

The RSA key pair for signing JWTs resolves from configuration; if unset, the dev
keys in `rust/src/keys/` are used and the build auto-generates a pair when the files
are missing. To regenerate deliberately:

```bash
python3 generate_keys.py
```

## Schema & backups

There is no migrations framework — the schema is created on boot from a declarative
definition. Schema changes are made as ad-hoc SQL and then reflected back into that
definition so a fresh boot matches production. Database dumps (create / download /
restore) are managed from the admin **Backups** page; see **Admin Panel**.

## Repository layout

```
frontend/   React 19 + Vite web app
rust/        Actix-web backend (binaries: backend, embedding-worker)
mobile/      Expo / React Native app
nginx/       default.conf.template (edge proxy)
md/          docs, plans, RESUME.md
docker-compose.yml   service orchestration (profiles server-stack, db-stack)
generate_keys.py     regenerate the JWT RSA key pair
```
