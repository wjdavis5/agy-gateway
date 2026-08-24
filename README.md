# agy-gateway

A zero-dependency Node 22 HTTP service that turns the headless **agy** CLI
(Antigravity agent CLI) into shared home-lab infrastructure: any machine on
the main LAN can POST a prompt and get agy's answer back, synchronously or
as an async job, without installing or authenticating agy itself.

Runs as a systemd service in its own Debian 12 LXC (**VMID 105,
`192.168.0.92:8100`**) on the Proxmox host `pve01`. LAN-only by design —
never exposed through the Cloudflare tunnel.

- Deploy / rollback / status: [`.claude/skills/deploy-agy-gateway/SKILL.md`](.claude/skills/deploy-agy-gateway/SKILL.md)
- Plan this was built from: `docs/plans/2026-08-24-001-feat-agy-gateway-plan.md` in the lab-manager repo

## API

All endpoints except `GET /health` require `Authorization: Bearer <token>`
(token in `/opt/agy-gateway/.env` on the container — container-only, mode
600, CSPRNG-generated). Request bodies are JSON, capped at 1 MB (413
beyond). Responses are JSON.

### POST /run — synchronous

Blocks until agy finishes (or the timeout budget expires) and returns the
full result in the response.

```bash
curl -s -X POST http://192.168.0.92:8100/run \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt": "Summarize why the sky is blue in one sentence.", "effort": "low"}'
```

Request fields:

| Field | Type | Default | Notes |
|---|---|---|---|
| `prompt` | string | required | The prompt text. Max 100,000 characters (agy receives it as a single CLI argument) |
| `effort` | `low\|medium\|high` | `high` | agy reasoning effort |
| `outputFormat` | `json\|text` | `json` | `json` returns agy's structured body; `text` returns raw stdout |
| `jsonSchema` | string | — | Inline JSON schema; agy enforces structured output into `structured_output`. Max 100,000 characters (single-CLI-argument limit) |
| `timeoutMs` | int | 300000 | Capped at 900000. **The budget spans queue wait plus execution** — a request that expires while queued returns a timeout without ever starting agy |

Success (200): `{"ok": true, "agy": {"conversation_id", "status": "SUCCESS", "response", "structured_output"?, "usage"}, "durationMs"}`.
When a schema was passed, trust `structured_output` — `response` can carry extra prose.

Failure statuses map from the typed `errorKind`:

| errorKind | HTTP | Meaning |
|---|---|---|
| `bad-request` | 400 | Invalid request fields |
| `timeout` | 504 | Budget expired (queued or executing) |
| `not-found` | 503 | agy binary missing |
| `exit` | 502 | agy exited non-zero (`stderrTail` carries detail) |
| `bad-output` | 502 | agy stdout wasn't the expected JSON |
| `agy-status` | 502 | agy reported a non-SUCCESS status (see live-verified notes below) |

### POST /jobs + GET /jobs/{id} — async

For runs longer than a client wants to hold a socket (Node's `fetch`
aborts at ~300 s by default — use async beyond that).

```bash
curl -s -X POST http://192.168.0.92:8100/jobs -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"prompt": "...", "timeoutMs": 900000}'
# -> 202 {"jobId": "...", "state": "queued"}
curl -s -H "Authorization: Bearer $TOKEN" http://192.168.0.92:8100/jobs/<jobId>
# -> {"jobId", "state": "queued|running|succeeded|failed", "createdAt", "startedAt"?, "finishedAt"?, "result"?|"error"?}
```

Jobs are **in-memory**: finished jobs are evicted after 24 h (`JOB_TTL_MS`)
and every job is lost on a service restart — poll returns 404 after either.
`GET /jobs` lists recent jobs (ids, states, timestamps only — never prompt
or result content).

### GET /health — unauthenticated

`200` healthy / `503` degraded (agy binary missing). Payload includes the
agy version (drift observability — see below), running/queued counts, and
stored job count.

## Execution model

At most `AGY_MAX_CONCURRENT` (default 3) agy processes run at once; further
requests wait in a FIFO queue. Parallel execution against the shared
`/root/.gemini` state was live-verified 2026-08-24 (3-way, distinct
conversation ids, no interference). The queue is unbounded by design
("queue rather than fail") — the health endpoint exposes depth.

The service and agy run as root inside an **unprivileged** LXC; the unit
sets `NoNewPrivileges` and `PrivateTmp`. agy is **never** invoked with
`--dangerously-skip-permissions`; `AGY_SANDBOX=true` additionally passes
`--sandbox`.

**Log policy:** journald logs carry method/path/status/jobId/duration at
most — never prompt bodies, schemas, or agy results.

## Environment variables (`/opt/agy-gateway/.env`, container-only)

| Variable | Default | Purpose |
|---|---|---|
| `AGY_GATEWAY_TOKEN` | required | Bearer token. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Rotate by writing a new value and `systemctl restart agy-gateway` |
| `PORT` | 8100 | Listen port |
| `AGY_PATH` | `/root/.local/bin/agy` | Absolute path (systemd's PATH excludes `/root/.local/bin`) |
| `AGY_TIMEOUT_MS` | 300000 | Default per-request budget |
| `AGY_TIMEOUT_MAX_MS` | 900000 | Cap on per-request `timeoutMs` |
| `AGY_MAX_CONCURRENT` | 3 | Parallel agy processes |
| `AGY_EFFORT` | high | Default reasoning effort |
| `AGY_SANDBOX` | false | Pass `--sandbox` on every run |
| `AGY_MAX_BODY_BYTES` | 1048576 | Request body cap |
| `JOB_TTL_MS` | 86400000 | Finished-job retention |

## Container provisioning record (2026-08-24)

First recorded LXC recipe in the lab — nothing before this documented a
`pct create`. Created on `pve01` (single SSH session — parallel sessions to
`192.168.0.101` collide, documented lab gotcha):

```bash
pct create 105 local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst \
  --hostname agy-gateway --unprivileged 1 --features nesting=1,keyctl=1 \
  --cores 2 --memory 4096 --swap 512 --rootfs local-lvm:8 \
  --net0 name=eth0,bridge=vmbr0,gw=192.168.0.1,ip=192.168.0.92/24 \
  --nameserver 1.1.1.1 --onboot 1 \
  --ssh-public-keys /root/.ssh/authorized_keys
```

Memory is 2x the plex-watcher's because parallel agy processes cost real
RAM. Then inside the container: `apt-get install curl ca-certificates`,
NodeSource `setup_22.x`, `apt-get install nodejs` (→ Node v22.23.2,
matching LXC 102). `192.168.0.92` was verified unclaimed (no ARP entry, no
ping reply) before assignment; there is no UDM reservation — if flaky
outages ever appear, check for a DHCP conflict first.

## agy bootstrap (copied from plex-watcher, 2026-08-24)

agy was **not** freshly installed: the binary and auth state were copied
from LXC 102 (the plex-watcher container) via a piped tar stream so POSIX
modes survive and nothing lands on the Windows desktop:

```bash
ssh root@192.168.0.90 'tar -czf - -C /root .local/bin/agy .gemini' \
  | ssh root@192.168.0.92 'tar -xzf - -C /root && chmod -R go-rwx /root/.gemini'
```

(Do NOT stage through the desktop: Windows OpenSSH re-sends files with
default modes — the binary loses its exec bit and the credential dir its
restrictive permissions — and a credential copy would linger on a third
machine.)

**Consequence: LXC 102 and 105 share one Antigravity credential.** Both
were verified working immediately after the copy. If agy's auth ever
rotates tokens on use, one container's refresh could invalidate the other
days later — if the plex-watcher classifier suddenly starts flagging
everything for review, suspect this first. Re-check 102 about a week after
any re-copy.

### Live-verified agy behavior (2026-08-24, agy 1.1.19, LXC 105)

- Headless invocation: `agy -p <prompt> --output-format json|text
  [--json-schema <inline>] --effort <low|medium|high> --print-timeout <Ns>
  [--sandbox]`. **`--print-timeout` defaults to 5m inside agy** — the
  gateway always passes it explicitly or agy self-terminates at 5 minutes.
- **Headless tool calls are auto-denied**: a prompt asking agy to read a
  file returned `status: "CANCELED"` with an empty response and a stderr
  note that a `read_file` permission "headless mode cannot prompt for...
  was auto-denied". A hostile prompt cannot make the gateway's agy touch
  the filesystem. With `--sandbox` the same probe returns `status:
  "ERROR"` with an `error` field in the body. Plain prompts succeed under
  `--sandbox`.
- Observed statuses: `SUCCESS`, `CANCELED`, `ERROR`. Non-SUCCESS maps to
  errorKind `agy-status` with stderr detail in `stderrTail`.
- 3-way parallel runs against the shared `/root/.gemini`: all SUCCESS,
  distinct `conversation_id`s, correct per-run answers.
- agy has **no serve/daemon/API mode** (checked `--help`, subcommands:
  agent/changelog/help/install/mcp/models/plugin/update) — this gateway
  isn't duplicating a built-in. agy self-updates (binary changed 1.1.15 →
  1.1.19 between 2026-08-19 and 08-24 on LXC 102); `/health` exposes the
  version so drift is observable. Re-verify these notes after a version
  change.

## Development

```bash
npm test        # node --test "src/**/*.test.js" — zero deps, no agy binary needed
```

Layout follows the plex conventions: thin `server.js` entrypoint; logic in
`src/` (`agyRunner.js` execution + semaphore, `jobs.js` store, `server.js`
handler + health, `config.js` env parsing); every I/O boundary injectable;
tests mock `execFileImpl` and pass duck-typed req/res objects.

## Known limitations (accepted)

- Plaintext HTTP on the trusted LAN; the token and prompt content are
  readable by anyone with a capture position.
- One shared token: any holder can read every job's result.
- No job cancellation; a disconnected sync client still holds its slot
  until agy finishes or times out.
- In-memory jobs lost on restart; deploys reset the store.
- Queue is unbounded; a runaway submit loop can build a long backlog
  (visible via `/health`).
