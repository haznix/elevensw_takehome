# Device Reconciliation Service

A small backend that reconciles desired configuration against a fleet of
remote network devices. Devices are behind firewalls, run heterogeneous
firmware (MikroTik, Cisco, etc.), and are unreliable. The service ingests
desired-state events, drives a per-device state machine through a
device-initiated check-in protocol, retries transient failures, and exposes
fleet observability.

ElevenSoftware Network & Devices take-home — see [adr/ADR.md](adr/ADR.md) for
the design rationale and [adr/AI-WORKFLOW.md](adr/AI-WORKFLOW.md) for the AI
workflow note.

## Layout

```
src/                  TypeScript backend (Fastify + better-sqlite3)
test/                 Failure-mode tests (vitest)
simulator/            Python device fleet simulator
adr/                  Design note + AI workflow note
```

## Requirements

- Node 20+
- Python 3.11+

## Setup

There are 3 parts to running this code, the backend server, the simulated device check-in and then generating events.

### Backend
```bash
# 1. Install backend deps
npm install

# 2. Start the backend (default :3000, SQLite at ./data.db)
npm start
# or for live reload during development:
npm run dev
```

### Simulator

Run these to get a fleet to start reporting in after the backend is running. 
In a second terminal:

```bash
# 3. Install the simulator (one-time)
cd simulator
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[test]"
python generate_fleet.py    # writes a 100-device fleet.yaml

# 4. Run the simulated fleet against the backend
python -m simulator.fleet --config fleet.yaml --target http://localhost:3000
```

### Generating Events

In a third terminal — push a desired-state event:

```bash
curl -X POST localhost:3000/v1/events \
  -H 'content-type: application/json' \
  -d '{"orgId":"acme","deviceId":"d-001","version":1,"config":{"ssid":"guest","vlan":10}}'
```

## The Dashboard


Open <http://localhost:3000/> in a browser to watch the dashboard. The rollup
counts shift `PENDING` → `APPLYING` → `IN_SYNC` over a few poll cycles.

To push to the entire fleet at once:

```bash
for i in $(seq -f "%03g" 1 100); do
  curl -sf -X POST http://localhost:3000/v1/events \
    -H 'content-type: application/json' \
    -d "{\"orgId\":\"acme\",\"deviceId\":\"d-$i\",\"version\":1,\"config\":{\"ssid\":\"guest\",\"vlan\":10}}" > /dev/null
done
```
Feel free to modify the version number.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/events` | Ingest a desired-state event. Body: `{ orgId, deviceId, vendor?, version, config }`. 202 on accept, 409 on stale version. Idempotent on `(deviceId, version)`. |
| `POST` | `/v1/devices/:id/checkin` | Device check-in. Body: `{ orgId?, vendor?, reportedVersion, reportedConfig?, lastApplyResult? }`. Reply: `{ instruction: "noop" }` or `{ instruction: "apply", targetVersion, targetConfig }`. |
| `GET` | `/v1/orgs/:orgId/devices` | Fleet listing for an org. |
| `GET` | `/v1/orgs/:orgId/rollup` | Per-state counts + `needsHuman` queue. |
| `GET` | `/v1/devices/:id` | Single device detail with full state-log history. |
| `GET` | `/metrics` | Prometheus text-format metrics. |
| `GET` | `/healthz` | Liveness probe. |
| `GET` | `/` | Live HTML dashboard (polls `/rollup` every 2s). |

## Tests
If you want to run tests without the simulator you can this. You will need to run in this in the console where you initialized the python VENV.

```bash
npm test                                  # backend failure-mode tests (vitest)
cd simulator && pytest                    # simulator chaos primitive tests
```

The backend test suite exercises the failure modes the prompt explicitly
flags:

- happy path
- out-of-order events (newer version, then older — older rejected)
- supersession (newer event arrives during in-flight `APPLYING`)
- transient retry → backoff → eventual success, failure_count reset
- transient retries past max → GIVE_UP
- permanent error → GIVE_UP immediately
- offline → return → reconcile (state preserved)
- post-apply drift detection
- duplicate event publish (idempotent ack)
- duplicate check-in (lost response — apply replayed safely)

## Configuration

Backend env vars:

- `PORT` — HTTP port (default `3000`)
- `DB_PATH` — SQLite file (default `./data.db`; use `:memory:` for ephemeral)
- `LOG_LEVEL` — pino level (default `info`)

Tunable policy in [src/state/policy.ts](src/state/policy.ts):

- `maxAttempts` — retries before GIVE_UP (default `6`)
- `baseBackoffMs` — base for exponential backoff (default `60_000`)
- `maxBackoffMs` — backoff cap (default `30 * 60_000`)
- `heartbeatThresholdMs` — silence before OFFLINE (default `60_000`)
- `applyingTimeoutMs` — APPLYING wait before transient failure (default `90_000`)
- `sweepIntervalMs` — background sweep cadence (default `10_000`)

## Assumptions

- Devices identify themselves by ID. In production this is replaced by
  mTLS-derived identity. The check-in handler accepts an optional `orgId` in
  the body so a fresh device can self-register on first contact (the
  simulator uses this).
- Versions are monotonic per device. Out-of-order events are rejected;
  duplicates are idempotent.
- The check-in JSON shape is a stand-in for real per-vendor protocols
  (RouterOS API, RESTCONF, NETCONF). A real adapter layer would translate
  generic apply calls into the vendor's wire format.
- 100 devices is a comfortable scale for a single-process backend with
  in-memory state and SQLite. The repository abstraction means swapping
  to Postgres + horizontally-scaled reconcilers is mechanical.

See [adr/ADR.md](adr/ADR.md) for what would change at higher scale.
