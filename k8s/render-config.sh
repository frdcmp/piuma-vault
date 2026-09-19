#!/bin/bash
# Renders k8s/00-config.yaml (gitignored) from .env. Run from the repo root.
set -euo pipefail
python3 - <<'PY'
import os
env={}
for line in open('.env'):
    line=line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k,v=line.split('=',1); env[k.strip()]=v.strip().strip('"').strip("'")
SECRET={'DB_PASSWORD','CLOUDFLARE_API_TOKEN','CLOUDFLARED_TOKEN','CLOUDFLARE_ACCOUNT_ID','TELEMETRY_API_KEY'}
SKIP={'COMPOSE_PROFILES','COMPOSE_NAME','COMPOSE_FILE','NGINX_PORT','DB_PORT_EXTERNAL'}
cfg={k:v for k,v in env.items() if k not in SECRET and k not in SKIP}
cfg['DB_HOST']='db'; cfg['MCP_WORKER_URL']='http://mcp-worker:8090'
sec={k:env[k] for k in SECRET if k in env}
b=lambda d: '\n'.join(f'  {k}: "{v}"' for k,v in sorted(d.items()))
open('k8s/00-config.yaml','w').write(
 "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: piuma-vault\n---\n"
 "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: pv-config\n  namespace: piuma-vault\ndata:\n"+b(cfg)+"\n---\n"
 "apiVersion: v1\nkind: Secret\nmetadata:\n  name: pv-secret\n  namespace: piuma-vault\ntype: Opaque\nstringData:\n"+b(sec)+"\n")
os.chmod('k8s/00-config.yaml',0o600)
print("rendered k8s/00-config.yaml (0600, gitignored)")
PY
