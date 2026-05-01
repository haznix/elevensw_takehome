import type { Store } from "../store/sqlite.js";
import type { DeviceRow, DeviceState } from "../types.js";

/**
 * Transition a device to a new state, recording the reason in state_log.
 * Runs in a transaction so the row update and log append are atomic.
 *
 * `patch` lets callers update the same row in the same write (e.g. set
 * desired_version when transitioning to PENDING). Pass `undefined` for fields
 * that should be cleared (it'll be written as NULL).
 */
export function transitionTo(
  store: Store,
  device: DeviceRow,
  toState: DeviceState,
  reason: string,
  now: number,
  patch: Partial<DeviceRow> = {},
): void {
  store.transaction(() => {
    store.updateDevice(device.id, {
      ...patch,
      state: toState,
      last_state_change_at: now,
    });
    store.appendStateLog({
      deviceId: device.id,
      fromState: device.state,
      toState,
      reason,
      at: now,
    });
  });
}
