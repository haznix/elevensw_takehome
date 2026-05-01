import type { FastifyInstance } from "fastify";
import type { Store } from "../store/sqlite.js";
import { transitionTo } from "../state/machine.js";
import type { IngestEvent } from "../types.js";
import { log } from "../log.js";

export function registerEventRoutes(
  app: FastifyInstance,
  store: Store,
  now: () => number,
): void {
  app.post("/v1/events", async (req, reply) => {
    const event = parseIngestEvent(req.body);
    if (!event) {
      reply.status(400);
      return { error: "invalid_body" };
    }

    const ts = now();

    return store.transaction(() => {
      store.upsertOrg(event.orgId, event.orgName);
      const device = store.upsertDevice({
        id: event.deviceId,
        orgId: event.orgId,
        networkId: event.networkId,
        vendor: event.vendor,
        now: ts,
      });

      const inserted = store.insertEvent({
        deviceId: event.deviceId,
        version: event.version,
        config: event.config,
        now: ts,
      });

      // Duplicate publish (same deviceId+version) — idempotent ack.
      if (!inserted.inserted) {
        reply.status(202);
        return { status: "duplicate" };
      }

      const currentDesired = device.desired_version ?? 0;

      // Out-of-order: an older version arrived after a newer one.
      // We've kept the event row for audit, but don't regress desired state.
      if (event.version <= currentDesired) {
        store.appendStateLog({
          deviceId: device.id,
          fromState: device.state,
          toState: device.state,
          reason: `ignored_stale_version v${event.version} (current desired v${currentDesired})`,
          at: ts,
        });
        reply.status(409);
        return {
          status: "stale",
          deviceId: device.id,
          currentDesiredVersion: currentDesired,
        };
      }

      // New target. Advance desired state and reset failure budget.
      const supersedingApplying = device.state === "APPLYING";
      const reason = supersedingApplying
        ? `event v${event.version} supersedes in-flight v${currentDesired}`
        : `event v${event.version} accepted`;

      transitionTo(store, device, "PENDING", reason, ts, {
        desired_version: event.version,
        desired_config_json: JSON.stringify(event.config),
        failure_count: 0,
        last_failure_reason: null,
        next_retry_at: null,
      });

      log.info(
        { deviceId: device.id, version: event.version, prevState: device.state },
        "event ingested",
      );

      reply.status(202);
      return { status: "accepted", deviceId: device.id, version: event.version };
    });
  });
}

function parseIngestEvent(body: unknown): IngestEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.orgId !== "string" || !b.orgId) return null;
  if (typeof b.deviceId !== "string" || !b.deviceId) return null;
  if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1)
    return null;
  if (!b.config || typeof b.config !== "object" || Array.isArray(b.config)) return null;
  return {
    orgId: b.orgId,
    orgName: typeof b.orgName === "string" ? b.orgName : undefined,
    networkId: typeof b.networkId === "string" ? b.networkId : undefined,
    deviceId: b.deviceId,
    vendor: typeof b.vendor === "string" ? b.vendor : undefined,
    version: b.version,
    config: b.config as Record<string, unknown>,
  };
}
