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

### Dev vs prod

`COMPOSE_FILE` in `.env` selects the mode, so the commands above never need `-f`:

```dotenv
COMPOSE_FILE=docker-compose.yml                            # dev — cargo-watch hot reload
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml    # prod — release binaries
```

`docker-compose.prod.yml` is an *override*: it redefines only the five Rust
services (one release image, a different binary each) and carries no db, nginx,
env or volumes of its own. It is never valid on its own — always layered over the
base file, which `COMPOSE_FILE` does for you.

## Nginx edge

`nginx/default.conf.template` adds the `/api/v1/` prefix, sets security headers, and
forwards the Cloudflare connecting-IP header so the backend sees the real client IP.
TLS terminates at Cloudflare; the origin serves plain HTTP.

## Deploying

Deployments run via Docker Compose on the host. What a deploy involves depends on
what changed:

```bash
git pull
cd frontend && bun install && bun run build && cd ..   # frontend: nginx serves dist/ from disk — done
docker compose up -d --build rust                      # backend (prod): rebuild the release image
```

In **dev** mode the backend hot-reloads under cargo-watch, so the `--build` step
is unnecessary. In **prod** the release image is built locally from
`rust/Dockerfile.prod` — there is nothing to `pull`. `rust/.dockerignore` keeps
the host `target/` cache and key material out of the build context.

## JWT keys

The RSA key pair for signing JWTs (and the EC P-256 pair for Web Push / VAPID)
resolves from `rust/src/keys/`; the build (`build.rs`) auto-generates whatever is
missing. To rotate deliberately, delete the relevant key files and rebuild:

```bash
rm rust/src/keys/jwt-*.pem    # or vapid_private.pem + vapid_public.txt
# next build regenerates them
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
```
