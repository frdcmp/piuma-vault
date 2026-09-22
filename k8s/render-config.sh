#!/bin/bash
# Renders everything the cluster needs from .env.k8s. Run from the repo root.
#
#   k8s/00-config.yaml   Namespace + ConfigMap + Secret (gitignored)
#   k8s/.rendered/       every other k8s/*.yaml with __REGISTRY__ filled in
#                        (gitignored)
#
#   ./k8s/render-config.sh && kubectl apply -f k8s/00-config.yaml -f k8s/.rendered/
#
# The committed manifests name images as __REGISTRY__/<image>:<tag>, so this
# public repo carries no one installation's registry address. REGISTRY_HOST in
# .env.k8s supplies it; it is a deploy-time value, never put in the ConfigMap.
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

# Deploy-time substitutions: consumed by this script, read by no pod.
DEPLOY_ONLY={'REGISTRY_HOST'}

cfg={k:v for k,v in cfg_all.items() if k not in SECRET and k not in DEPLOY_ONLY}
sec={k:v for k,v in cfg_all.items() if k in SECRET}

# A key added to dev and forgotten here is the failure mode this split
# introduces, so name it rather than rendering a quietly incomplete config.
if os.path.exists('.env'):
    dev=load('.env')
    COMPOSE_ONLY={'COMPOSE_PROFILES','COMPOSE_NAME','COMPOSE_FILE','NGINX_PORT','DB_PORT_EXTERNAL'}
    # Absent from .env.k8s on purpose: the Deployments build these per-pod via
    # fieldRef, which a single ConfigMap value cannot express.
    K8S_INJECTED={'SERVER_NAME','NODE_NAME'}
    missing=sorted(set(dev) - set(cfg_all) - COMPOSE_ONLY - K8S_INJECTED)
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

import glob
reg=cfg_all.get('REGISTRY_HOST','')
if not reg or '<' in reg:
    sys.exit("error: REGISTRY_HOST missing from .env.k8s (see .env.k8s.example)")
os.makedirs('k8s/.rendered', exist_ok=True)
for old in glob.glob('k8s/.rendered/*.yaml'): os.remove(old)
n=0
for src in sorted(glob.glob('k8s/*.yaml')):
    if os.path.basename(src).startswith('00-config'): continue
    out=open(src).read().replace('__REGISTRY__', reg)
    if '__' in ''.join(l for l in out.splitlines() if 'image:' in l):
        sys.exit(f"error: unfilled placeholder left in {src}")
    open(os.path.join('k8s/.rendered', os.path.basename(src)),'w').write(out); n+=1
print(f"rendered {n} manifests into k8s/.rendered/ (registry {reg})")
PY
