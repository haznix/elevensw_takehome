# Device Reconciliation Service

Author: Hasan Rashid
Date: 2026-04-30


## Context

Reconcile desired configuration against ~100 simulated remote network devices. Devices are
behind firewalls, run heterogeneous firmware (MikroTik, Cisco, etc.), and are unreliable
(timeouts, transient errors, occasional rejects, offline windows). 

---

## ADR-1: Device transport, short-poll HTTPS check-in

**Decision.** Devices initiate a periodic `POST /v1/devices/:id/checkin` over HTTPS. The
response piggybacks any pending instruction (`apply` with target config, or `noop`). The check-in interval is configurable. Trivial firewall traversal, stateless on the server, low resource cost per device, identical mental model regardless of vendor firmware but latency is bound by poll interval. It's best for smaller fleet size, especially simulation but in a real production grade environment, I would go with MQTT due to its QoS and scalability. 





**Consequences.** Latency for a config push equals the device's poll interval (default
10s in the simulator). Acceptable for the use case (config rollouts, not real-time control).
The transport layer is replaceable: the only device-facing contract is the JSON shape of
the check-in request/response, so we can layer MQTT or WebSocket later without changing
state machine or storage.

---

## ADR-2: State store SQLite (`better-sqlite3`)

**Decision.** Single-file SQLite, accessed synchronously in-process via `better-sqlite3`.
All writes go through a thin repository module.

**Why.** Zero infra to spin up; one binary, one file, fully transactional. Synchronous API
fits the request handler model without callback gymnastics. Performance at 100 devices is
microseconds per op.

**Trade-offs.** Single-writer; no horizontal scale. Repository abstraction means
swapping to Postgres is mechanical (rewrite ~1 file, change connection setup).

---

## ADR-3: Reconciliation dual trigger (fast path + safety-net sweep)

**Decision.** Reconcile on two triggers:

1. **On check-in** (fast path) — when a device checks in, the handler reads its row, compares
   `desired_version` to `reported_version`, and includes the apply instruction in the same
   response. No queue, no async hand-off. This is the latency-critical path.
2. **Background sweep** every 10s — scans for offline devices (no check-in past heartbeat
   threshold), stuck `APPLYING` rows past timeout, retry timers that have come due, and
   post-apply config drift.

**Why both.** The fast path keeps the common case latency at one round-trip. The sweep is
the liveness guarantee — it catches every condition where *no event triggers anything*
(device went silent; retry timer fired; drift discovered out of band). A single trigger
would either be slow (sweep-only) or unsound (fast-path-only misses offline transitions).

**Trade-off.** Two code paths, two tests. Worth it for the latency / liveness separation.

---

## ADR-4: State model 

**States.** `IN_SYNC | PENDING | APPLYING | FAILED_TRANSIENT | GIVE_UP | DRIFTING | OFFLINE`.

The decision worth justifying is that **`DRIFTING` is a distinct state from `FAILED_TRANSIENT`**.
Drift means the device *acknowledged* an apply, then later reported a config that diverges
(local override, manual SSH edit, partial revert). Failure means the apply never succeeded.
Both feed back through the retry pipeline, but operators care about the distinction:
drift implies a human or out-of-band system is involved and may indicate a process problem,
not just a network blip.

`OFFLINE` is treated as orthogonal — the previous state is preserved on return. A device
that was `APPLYING` when it went offline resumes `APPLYING` on first check-in (then
either confirms or fails normally).

**Persistence.** Every transition is logged to an append-only `state_log` table with a
reason string. Operators can reconstruct exactly why a device is where it is.

---

## ADR-5: Idempotency & out-of-order events

**Decision.** Events are uniquely keyed `(device_id, version)`. The version is monotonic
per device and authoritative. Three rules:

1. Ingest with a version `<=` current desired → 409 Conflict (no state change). Idempotent
   replays of the same `(deviceId, version, config)` return 202.
2. Ingest with a version `>` current desired during an `APPLYING` window → the older
   in-flight target is **superseded**; we move directly to `APPLYING` for the newer
   version. State log records the supersession.
3. Device-reported version is the source of truth for "what's actually running." We never
   trust the server-side notion of "what we sent" alone — the device's reportedVersion
   in the next check-in is what settles a transition.

**Why.** Real upstreams retry, reorder, and occasionally double-publish. 

---

## ADR-6: Retry policy 

**Decision.** Transient errors (timeouts, 5xx, connection-reset): backoff
`min(60s · 2^n, 30min) ± 20% jitter`, max 6 attempts. Permanent errors (4xx with
`permanent: true`, schema-invalid configs): straight to `GIVE_UP` with no retries.

**Why bounded.** Unbounded retries hide systemic failure and make the "needs human"
queue invisible. `GIVE_UP` is a first-class state that surfaces in the rollup view,
so the fleet's broken edge is countable.

---

## ADR-7: TS backend, Python simulator

**Decision.** Backend (ingestion, reconciler, state machine, observability) in TypeScript
(Node 20, Fastify, `better-sqlite3`). Device fleet simulator in Python (`asyncio` + `httpx`).

**Why.** The backend is statically-typed code where the state machine and request handlers
benefit from TS's type narrowing. The simulator is exploratory chaos-injection code where
Python's `dataclass` + `asyncio` patterns are concise and the iteration loop is faster.

---

## What I'd change with more time

- **mTLS for device identity.** Today devices identify by ID. Production needs per-device
  certs (or short-lived JWTs from a device-bootstrap flow) so a leaked deviceId doesn't
  let anyone pose as that device.
- **Per-vendor `DeviceAdapter` interface.** The check-in JSON shape is a stand-in. A real
  system has `MikrotikAdapter`, `CiscoAdapter`, etc. behind an interface that translates
  generic `apply(config)` into the vendor's actual protocol (RouterOS API, RESTCONF, NETCONF).
- **Reconciler workers, not in-process loop.** At 100 devices the sweep is microseconds.
  At 100k I'd shard by `orgId` hash, run reconciler workers as a horizontally scaled
  consumer of a state-change stream (Redis stream / Kafka), and move SQLite → Postgres.
- **Real metrics + tracing.** Prometheus text format is in; OpenTelemetry tracing is not.
  In a real on-call scenario the question "why is device X stuck?" wants spans, not log
  greps.
- **A second grouping level — property under org.** Hospitality reality: an org owns many
  properties; each property has its own device subset. One more column, one more rollup
  endpoint, but worth doing properly day one.
- **Configurable per-device poll interval.** Today it's a global constant. In production,
  flaky devices should back off their own check-in cadence to avoid thundering-herd retries
  during recovery.
- **Drift remediation policy hooks.** Today drift always triggers re-apply. Some operators
  want a "freeze on drift" mode (stop overwriting until a human confirms). Worth a
  per-device or per-org policy flag.
