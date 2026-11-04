---
name: vault-deploy
description: Develop and ship Piuma Vault itself — check a change (cargo check and tests, the web build, Biome), deploy to k3s (build the rust, nginx and whatsapp-bridge images, push them tagged by image id, point the manifests at the tags, apply, roll out, health), read production's database and logs, run a hand migration. Use for "deploy", "deploy the vault", "ship it", "is it deployed", "check it builds", "the vault's logs", "run this on prod", "migrate the schema".
---

# Piuma Vault: check, deploy, production

Deploy only when the user says so. Production writes (SQL, migrations) only with their OK.

## Check a change

```bash
# backend: check into a writable target dir (the repo's rust/target can belong to root, from Docker)
cd rust && CARGO_TARGET_DIR=<a writable dir outside /tmp> cargo check --bin backend
CARGO_TARGET_DIR=<same> cargo test --lib <module>           # e.g. pigeon

# web
cd frontend && bunx biome check --write <changed files>
bun run build --outDir /tmp/pv-fe-check; rm -rf /tmp/pv-fe-check
```

Never `cargo build` or `docker compose build` for the dev stack (it runs under `cargo watch`).

## Deploy to k3s

Images are built locally, pushed to the cluster's registry (`REGISTRY_HOST` in `.env.k8s`) tagged by image id, and the manifests in `k8s/` name the tag.

```bash
# 1. build what changed
docker build -q -f rust/Dockerfile.prod --target runtime -t piuma-vault-rust-prod:latest rust
(cd frontend && bun run build) && docker build -q -f k8s/nginx.Dockerfile -t piuma-vault-nginx-k8s:latest .
docker build -q -t piuma-vault-whatsapp-bridge:latest whatsapp-bridge

# 2. push, tagged by image id
REG=$(grep -E '^REGISTRY_HOST=' .env.k8s | cut -d= -f2- | tr -d '"'"'")
for pair in piuma-vault-rust-prod=piuma-vault-rust piuma-vault-nginx-k8s=piuma-vault-nginx-k8s piuma-vault-whatsapp-bridge=piuma-vault-whatsapp-bridge; do
  src=${pair%%=*}; dst=${pair#*=}; t=$(docker image inspect --format '{{.Id}}' "$src:latest" | cut -c8-19)
  docker tag "$src:latest" "$REG/$dst:$t" && docker push -q "$REG/$dst:$t" >/dev/null && echo "$dst $t"
done
```

3. Put the new tags in `k8s/20-app.yaml` (`piuma-vault-rust:…`: the API and every worker), `k8s/30-nginx.yaml`, `k8s/25-whatsapp.yaml`; commit `deploy(k8s): rust …, nginx … — what`.

4. Apply and wait:

```bash
./k8s/render-config.sh >/dev/null && kubectl apply -f k8s/00-config.yaml -f k8s/.rendered/
for d in rust cron-worker embedding-worker notification-worker pigeon-worker whatsapp-bridge nginx; do
  kubectl -n piuma-vault rollout status deploy/$d --timeout=300s | tail -1; done
curl -s -A vault-check "$VAULT_URL/api/v1/health"     # a 502 for a few seconds while pods swap is normal
```

A docker build copies its context when it starts: a commit made during a build isn't in it; rebuild.

## Production

```bash
kubectl -n piuma-vault exec -i deploy/db -- sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -At' <<'EOF2'
SELECT …;
EOF2
kubectl -n piuma-vault logs deploy/rust --since=30m          # the API
kubectl -n piuma-vault logs deploy/pigeon-worker --since=30m # the Inbox: triage, agent, pushes
```

Writes run in a transaction (`BEGIN; … RETURNING …; COMMIT;`), after the user's OK.

**Schema:** `rust/src/db/db_init.rs` is the schema of record, create-only. A new column: the `ALTER TABLE` by hand on production (with the OK), then the CREATE in `db_init.rs` is updated to match.

Client errors (the web app, the phone apps) arrive at `POST /telemetry/client` and join the backend's telemetry, `source = "frontend"`.
