import type { FastifyInstance } from "fastify";
import type { Store } from "../store/sqlite.js";
import { transitionTo } from "../state/machine.js";
import { POLICY, nextRetryAt, shouldGiveUp } from "../state/policy.js";
import type {
  ApplyResult,
  CheckinRequest,
  CheckinResponse,
  Config,
  DeviceRow,
  DeviceState,
} from "../types.js";
import { log } from "../log.js";

export interface CheckinDeps {
  rng?: () => number;
}

export function registerCheckinRoutes(
  app: FastifyInstance,
  store: Store,
  now: () => number,
  deps: CheckinDeps = {},
): void {
  app.post<{ Params: { id: string } }>(
    "/v1/devices/:id/checkin",
    async (req, reply) => {
      const deviceId = req.params.id;
      const body = parseCheckin(req.body);
      if (!body) {
        reply.status(400);
        return { error: "invalid_body" };
      }

      const ts = now();

      return store.transaction(() => {
        let device = store.getDevice(deviceId);
        if (!device) {
          // Auto-register if body includes orgId. In production this is replaced by
          // mTLS-derived identity; for the take-home it lets simulators bootstrap
          // without a separate enrollment call.
          const orgId = body.orgId;
          if (!orgId) {
            reply.status(404);
            return { error: "unknown_device" };
          }
          store.upsertOrg(orgId, body.orgName);
          device = store.upsertDevice({
            id: deviceId,
            orgId,
            networkId: body.networkId,
            vendor: body.vendor,
            now: ts,
          });
          store.appendStateLog({
            deviceId,
            fromState: null,
            toState: "IN_SYNC",
            reason: "registered on first check-in",
            at: ts,
          });
        }

        // Update last_checkin_at first thing — even if everything else fails,
        // we want to record the device is alive.
        store.updateDevice(deviceId, { last_checkin_at: ts });
        device = store.getDevice(deviceId)!;

        // OFFLINE → restore prior state on return.
        if (device.state === "OFFLINE") {
          const restore: DeviceState = device.pre_offline_state ?? "IN_SYNC";
          transitionTo(
            store,
            device,
            restore,
            `check-in resumed; restoring pre-offline state ${restore}`,
            ts,
            { pre_offline_state: null },
          );
          device = store.getDevice(deviceId)!;
        }

        // Process apply ack from previous instruction, if any.
        if (body.lastApplyResult) {
          device = applyAck(store, device, body.lastApplyResult, ts, deps);
        }

        // Update reported state (independent of ack — devices may volunteer their
        // current view at any check-in).
        if (body.reportedVersion !== undefined && body.reportedVersion !== null) {
          store.updateDevice(deviceId, {
            reported_version: body.reportedVersion,
            ...(body.reportedConfig !== undefined
              ? { reported_config_json: JSON.stringify(body.reportedConfig) }
              : {}),
          });
          device = store.getDevice(deviceId)!;
        }

        // Detect post-apply drift: device says it has v=desired_version but the
        // running config diverges from what we asked for.
        if (
          device.state === "IN_SYNC" &&
          device.reported_version !== null &&
          device.desired_version !== null &&
          device.reported_version === device.desired_version &&
          device.reported_config_json !== null &&
          device.desired_config_json !== null &&
          !configsEqual(device.reported_config_json, device.desired_config_json)
        ) {
          transitionTo(store, device, "DRIFTING", "post-apply drift detected", ts);
          device = store.getDevice(deviceId)!;
        }

        // Decide what instruction to send back.
        const response = decideInstruction(device, ts);
        if (response.instruction === "apply" && device.state !== "APPLYING") {
          transitionTo(
            store,
            device,
            "APPLYING",
            `delivering apply v${response.targetVersion}`,
            ts,
          );
        }

        log.debug(
          {
            deviceId,
            instruction: response.instruction,
            state: store.getDevice(deviceId)?.state,
          },
          "checkin handled",
        );

        return response;
      });
    },
  );
}

function applyAck(
  store: Store,
  device: DeviceRow,
  result: ApplyResult,
  ts: number,
  deps: CheckinDeps,
): DeviceRow {
  if (result.kind === "success") {
    const newReportedVersion = result.appliedVersion;
    const newReportedConfigJson = JSON.stringify(result.appliedConfig);
    const targetReached =
      device.desired_version !== null &&
      newReportedVersion >= device.desired_version;

    if (targetReached) {
      transitionTo(store, device, "IN_SYNC", `apply succeeded`, ts, {
        reported_version: newReportedVersion,
        reported_config_json: newReportedConfigJson,
        failure_count: 0,
        last_failure_reason: null,
        next_retry_at: null,
      });
    } else {
      // Device confirmed an apply, but it was for a now-superseded version.
      // Stay PENDING — next check-in will deliver the newer instruction.
      transitionTo(
        store,
        device,
        "PENDING",
        `apply v${newReportedVersion} confirmed but v${device.desired_version} is now desired`,
        ts,
        {
          reported_version: newReportedVersion,
          reported_config_json: newReportedConfigJson,
        },
      );
    }
  } else if (result.kind === "transient_error") {
    const failureCount = device.failure_count + 1;
    if (shouldGiveUp(failureCount)) {
      transitionTo(
        store,
        device,
        "GIVE_UP",
        `transient retries exhausted: ${result.reason}`,
        ts,
        {
          failure_count: failureCount,
          last_failure_reason: result.reason,
          next_retry_at: null,
        },
      );
    } else {
      const retryAt = nextRetryAt(failureCount, ts, deps.rng);
      transitionTo(
        store,
        device,
        "FAILED_TRANSIENT",
        `transient apply error (attempt ${failureCount}): ${result.reason}`,
        ts,
        {
          failure_count: failureCount,
          last_failure_reason: result.reason,
          next_retry_at: retryAt,
        },
      );
    }
  } else {
    transitionTo(
      store,
      device,
      "GIVE_UP",
      `permanent apply error: ${result.reason}`,
      ts,
      {
        failure_count: device.failure_count + 1,
        last_failure_reason: result.reason,
        next_retry_at: null,
      },
    );
  }
  return store.getDevice(device.id)!;
}

function decideInstruction(device: DeviceRow, ts: number): CheckinResponse {
  // No desired config yet → nothing to do.
  if (device.desired_version === null || device.desired_config_json === null) {
    return { instruction: "noop" };
  }
  // Already on desired version and not drifting → nothing to do.
  if (
    device.state === "IN_SYNC" &&
    device.reported_version !== null &&
    device.reported_version >= device.desired_version
  ) {
    return { instruction: "noop" };
  }
  // Given up — operator has to intervene.
  if (device.state === "GIVE_UP") {
    return { instruction: "noop" };
  }
  // In transient backoff and not yet due — sit tight.
  if (
    device.state === "FAILED_TRANSIENT" &&
    device.next_retry_at !== null &&
    device.next_retry_at > ts
  ) {
    return { instruction: "noop" };
  }
  // Anything else (PENDING, FAILED_TRANSIENT past retry, DRIFTING, or APPLYING
  // re-delivery for a device that lost the prior response) → apply.
  return {
    instruction: "apply",
    targetVersion: device.desired_version,
    targetConfig: JSON.parse(device.desired_config_json) as Config,
  };
}

function configsEqual(aJson: string, bJson: string): boolean {
  // Compare on canonicalised parsed value so key-order doesn't trigger false drift.
  const a = JSON.stringify(canonicalise(JSON.parse(aJson)));
  const b = JSON.stringify(canonicalise(JSON.parse(bJson)));
  return a === b;
}

function canonicalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalise);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) sorted[k] = canonicalise(o[k]);
    return sorted;
  }
  return v;
}

interface ParsedCheckin extends CheckinRequest {
  orgId?: string;
  orgName?: string;
  networkId?: string;
  vendor?: string;
}

function parseCheckin(body: unknown): ParsedCheckin | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const out: ParsedCheckin = {
    reportedVersion:
      b.reportedVersion === null
        ? null
        : typeof b.reportedVersion === "number"
          ? b.reportedVersion
          : null,
  };
  if (typeof b.orgId === "string") out.orgId = b.orgId;
  if (typeof b.orgName === "string") out.orgName = b.orgName;
  if (typeof b.networkId === "string") out.networkId = b.networkId;
  if (typeof b.vendor === "string") out.vendor = b.vendor;
  if (b.reportedConfig && typeof b.reportedConfig === "object" && !Array.isArray(b.reportedConfig)) {
    out.reportedConfig = b.reportedConfig as Config;
  }
  if (b.lastApplyResult) {
    const r = b.lastApplyResult as Record<string, unknown>;
    if (r.kind === "success" && typeof r.appliedVersion === "number" && r.appliedConfig) {
      out.lastApplyResult = {
        kind: "success",
        appliedVersion: r.appliedVersion,
        appliedConfig: r.appliedConfig as Config,
      };
    } else if (
      (r.kind === "transient_error" || r.kind === "permanent_error") &&
      typeof r.reason === "string"
    ) {
      out.lastApplyResult = { kind: r.kind, reason: r.reason };
    }
  }
  return out;
}

// Avoid "unused" complaint on the placeholder export.
export { POLICY };
