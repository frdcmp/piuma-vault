#!/bin/bash
# Renders k8s/00-config.yaml (gitignored) from .env.k8s. Run from the repo root.
#
#   .env      -> the DEV file, used by docker compose. Never read here.
#   .env.k8s  -> the CLUSTER file, authoritative for production. Read here.
#
# This script applies NO value overrides. If dev and prod differ, they differ
# because the two files say different things.
#
# NOTE: this repo is PUBLIC. Neither .env nor .env.k8s is ever committed --
# only .env.example. Encrypted copies live in .backup/ (gitignored).
set -euo pipefail
python3 - <<'PY'
import os, sys

def load(path):
    env={}
    for line in open(path):
        line=line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k,v=line.split('=',1); env[k.strip()]=v.strip().strip('"').strip("'")
    return env

if not os.path.exists('.env.k8s'):
    sys.exit("error: .env.k8s not found (see .backup/ for the encrypted copy)")
cfg_all = load('.env.k8s')

# Key names only; values live in .env.k8s. These render into a k8s Secret.
SECRET={'DB_PASSWORD','CLOUDFLARE_API_TOKEN','CLOUDFLARED_TOKEN',
        'CLOUDFLARE_ACCOUNT_ID','TELEMETRY_API_KEY'}

cfg={k:v for k,v in cfg_all.items() if k not in SECRET}
sec={k:v for k,v in cfg_all.items() if k in SECRET}

# A key added to dev and forgotten here is the failure mode this split
# introduces, so name it rather than rendering a quietly incomplete config.
if os.path.exists('.env'):
    dev=load('.env')
    COMPOSE_ONLY={'COMPOSE_PROFILES','COMPOSE_NAME','COMPOSE_FILE','NGINX_PORT','DB_PORT_EXTERNAL'}
    missing=sorted(set(dev) - set(cfg_all) - COMPOSE_ONLY)
    if missing:
        print(f"  WARNING: in .env but not .env.k8s -> {missing}", file=sys.stderr)
        print( "           add them to .env.k8s, or to COMPOSE_ONLY if dev-only.", file=sys.stderr)

b=lambda d: '\n'.join(f'  {k}: "{v}"' for k,v in sorted(d.items()))
open('k8s/00-config.yaml','w').write(
 "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: piuma-vault\n---\n"
 "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: pv-config\n  namespace: piuma-vault\ndata:\n"+b(cfg)+"\n---\n"
 "apiVersion: v1\nkind: Secret\nmetadata:\n  name: pv-secret\n  namespace: piuma-vault\ntype: Opaque\nstringData:\n"+b(sec)+"\n")
os.chmod('k8s/00-config.yaml',0o600)
print(f"rendered k8s/00-config.yaml from .env.k8s — {len(cfg)} config keys, {len(sec)} secrets (0600, gitignored)")
PY
