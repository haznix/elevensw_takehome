import type { Store } from "../store/sqlite.js";
import { transitionTo } from "../state/machine.js";
import { POLICY, nextRetryAt, shouldGiveUp } from "../state/policy.js";
import { log } from "../log.js";

export interface SweepDeps {
  rng?: () => number;
}

export interface SweepResult {
  scanned: number;
  markedOffline: number;
  applyingTimedOut: number;
}

/**
 * Background safety-net pass over the device fleet:
 *  - Mark devices OFFLINE if they haven't checked in within the heartbeat threshold.
 *  - Treat stuck APPLYING rows as transient failures (device may have lost the
 *    response, or simply never confirmed).
 *
 * Designed to run every {@link POLICY.sweepIntervalMs} ms.
 */
export function sweep(store: Store, now: number, deps: SweepDeps = {}): SweepResult {
  const result: SweepResult = { scanned: 0, markedOffline: 0, applyingTimedOut: 0 };
  const devices = store.listAllDevices();
  result.scanned = devices.length;

  for (const device of devices) {
    // OFFLINE detection. Don't re-mark already-offline devices.
    if (
      device.state !== "OFFLINE" &&
      device.last_checkin_at !== null &&
      now - device.last_checkin_at > POLICY.heartbeatThresholdMs
    ) {
      transitionTo(
        store,
        device,
        "OFFLINE",
        `no check-in for ${Math.round((now - device.last_checkin_at) / 1000)}s`,
        now,
        { pre_offline_state: device.state },
      );
      result.markedOffline += 1;
      continue;
    }

    // APPLYING timeout: device was sent an apply, never acknowledged.
    if (
      device.state === "APPLYING" &&
      device.last_state_change_at !== null &&
      now - device.last_state_change_at > POLICY.applyingTimeoutMs
    ) {
      const failureCount = device.failure_count + 1;
      const reason = "apply timeout — no acknowledging check-in";
      if (shouldGiveUp(failureCount)) {
        transitionTo(store, device, "GIVE_UP", `${reason}; retries exhausted`, now, {
          failure_count: failureCount,
          last_failure_reason: reason,
          next_retry_at: null,
        });
      } else {
        const retryAt = nextRetryAt(failureCount, now, deps.rng);
        transitionTo(
          store,
          device,
          "FAILED_TRANSIENT",
          `${reason} (attempt ${failureCount})`,
          now,
          {
            failure_count: failureCount,
            last_failure_reason: reason,
            next_retry_at: retryAt,
          },
        );
      }
      result.applyingTimedOut += 1;
    }
  }

  if (result.markedOffline > 0 || result.applyingTimedOut > 0) {
    log.info(result, "sweep results");
  } else {
    log.debug(result, "sweep results");
  }

  return result;
}

export function startSweepLoop(
  store: Store,
  now: () => number,
  deps: SweepDeps = {},
): { stop: () => void } {
  const handle = setInterval(() => {
    try {
      sweep(store, now(), deps);
    } catch (err) {
      log.error({ err }, "sweep failed");
    }
  }, POLICY.sweepIntervalMs);
  // Don't keep the event loop alive just for sweeps.
  handle.unref();
  return { stop: () => clearInterval(handle) };
}
