---
name: deploy-agy-gateway
description: Deploy, roll back, or check the status of the agy-gateway service running on the pve01 Proxmox LXC (container 105, 192.168.0.92). Use whenever the user asks to deploy/redeploy/push/ship a change to the gateway, roll it back, or check whether it's running/healthy.
---

# Deploy agy-gateway (pve01 LXC 105)

The gateway does not run on this Windows desktop — it runs as a systemd
service (`agy-gateway.service`) inside a dedicated Debian LXC on the home
lab's Proxmox host. Architecture and API reference live in `README.md`.

## Facts this skill assumes

| | |
|---|---|
| SSH key | `C:\git\homeassistant\vm\ha_vm_ed25519` (same lab key as `pve01`/`donkey1`/plex-watcher) |
| Container IP | `192.168.0.92` (direct SSH — no hop through pve01 for app-level work) |
| Proxmox host | `192.168.0.101` (container-level ops only: start/stop/reboot, `pct enter`) |
| App path in container | `/opt/agy-gateway` |
| Service name | `agy-gateway` (systemd; unit file versioned at `deploy/agy-gateway.service`) |
| Port | `8100` (`GET /health` unauthenticated; everything else needs the bearer token) |
| `.env` location | `/opt/agy-gateway/.env` — lives ONLY on the container, mode `600`, never in the repo or deploy archive, never overwritten by a deploy |

All commands run from a Git Bash prompt on the Windows desktop, from the
`C:\git\agy-gateway` repo root.

## 1. Deploy a new version

Preconditions: your local changes are the version you want live, and
`node --test "src/**/*.test.js"` passes locally.

```bash
cd /c/git/agy-gateway
tar --exclude='.git' --exclude='node_modules' --exclude='.env' -czf /tmp/agy-gateway-deploy.tar.gz .

scp -i "C:/git/homeassistant/vm/ha_vm_ed25519" -o StrictHostKeyChecking=no /tmp/agy-gateway-deploy.tar.gz root@192.168.0.92:/tmp/

ssh -i "C:/git/homeassistant/vm/ha_vm_ed25519" -o StrictHostKeyChecking=no root@192.168.0.92 "
  rm -rf /opt/agy-gateway-old &&
  mv /opt/agy-gateway /opt/agy-gateway-old &&
  mkdir /opt/agy-gateway &&
  tar -xzf /tmp/agy-gateway-deploy.tar.gz -C /opt/agy-gateway --no-same-owner &&
  cp /opt/agy-gateway-old/.env /opt/agy-gateway/.env &&
  chown -R root:root /opt/agy-gateway &&
  rm /tmp/agy-gateway-deploy.tar.gz &&
  cp /opt/agy-gateway/deploy/agy-gateway.service /etc/systemd/system/agy-gateway.service &&
  systemctl daemon-reload &&
  systemctl restart agy-gateway &&
  sleep 2 &&
  systemctl status agy-gateway --no-pager
"
```

**`--no-same-owner` is load-bearing, not optional** (same lesson as the
plex-watcher deploy, live-verified 2026-08-08 there): without it, tar tries
to preserve Windows-origin numeric ownership, fails against the
unprivileged LXC's UID mapping, and **exits non-zero**, silently breaking
the `&&` chain — the `.env` restore, service-unit install, and restart never
run, while the old process keeps serving its already-loaded code.

The unit-file copy + `daemon-reload` on every deploy keeps
`/etc/systemd/system/agy-gateway.service` in sync with the versioned
`deploy/agy-gateway.service` — the unit carries the load-bearing
`Environment=HOME=/root` line (see the comment inside it).

## 2. Roll back to the previous version

Only one version of history: `-old` is overwritten by each deploy.

```bash
ssh -i "C:/git/homeassistant/vm/ha_vm_ed25519" -o StrictHostKeyChecking=no root@192.168.0.92 "
  test -d /opt/agy-gateway-old || { echo 'No rollback point available.'; exit 1; } &&
  rm -rf /opt/agy-gateway-failed &&
  mv /opt/agy-gateway /opt/agy-gateway-failed &&
  mv /opt/agy-gateway-old /opt/agy-gateway &&
  systemctl restart agy-gateway &&
  sleep 2 &&
  systemctl status agy-gateway --no-pager
"
```

The bad version is preserved at `/opt/agy-gateway-failed` for inspection
(the lab's "never destroy, move aside" convention).

## 3. Check status / live logs

Fastest check — the health endpoint (no token needed):

```bash
curl -s http://192.168.0.92:8100/health
```

`status: "ok"` + HTTP 200 = healthy; `degraded` + 503 means the agy binary
went missing at `AGY_PATH`. The payload also carries the agy version and
running/queued/stored job counts.

```bash
# One-shot status
ssh -i "C:/git/homeassistant/vm/ha_vm_ed25519" -o StrictHostKeyChecking=no root@192.168.0.92 "systemctl status agy-gateway --no-pager"

# Recent log lines (never contain prompt/result bodies by design)
ssh -i "C:/git/homeassistant/vm/ha_vm_ed25519" -o StrictHostKeyChecking=no root@192.168.0.92 "journalctl -u agy-gateway --no-pager -n 50"
```

Authenticated smoke (reads the token on the container — never print it):

```bash
ssh -i "C:/git/homeassistant/vm/ha_vm_ed25519" -o StrictHostKeyChecking=no root@192.168.0.92 '
  TOKEN=$(grep ^AGY_GATEWAY_TOKEN= /opt/agy-gateway/.env | cut -d= -f2)
  curl -s -X POST http://localhost:8100/run -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"prompt\":\"Reply with exactly the word OK\",\"effort\":\"low\",\"timeoutMs\":120000}"'
```

## 4. Run the test suite on the container

Zero-dependency `node --test` — no npm install needed:

```bash
ssh -i "C:/git/homeassistant/vm/ha_vm_ed25519" -o StrictHostKeyChecking=no root@192.168.0.92 "cd /opt/agy-gateway && npm test 2>&1 | tail -8"
```

## 5. Container-level operations (rare — pve01, not the container)

```bash
ssh -i "C:/git/homeassistant/vm/ha_vm_ed25519" -o StrictHostKeyChecking=no root@192.168.0.101 "pct status 105"
ssh -i "C:/git/homeassistant/vm/ha_vm_ed25519" -o StrictHostKeyChecking=no root@192.168.0.101 "pct reboot 105"
```

Don't run parallel SSH sessions to `pve01` itself (documented lab gotcha —
they collide and exit 255); the container's own IP (`192.168.0.92`) has no
such restriction.

## 6. agy on this container

agy lives at `/root/.local/bin/agy` with auth/config state in
`/root/.gemini/` — both **copied from the plex-watcher container (LXC 102,
2026-08-24)**, so the two containers share one Antigravity credential. A
deploy never touches either path. If agy itself breaks, see README's
"agy bootstrap" section before re-copying; a rotation/invalidation on one
container likely affects the other.
