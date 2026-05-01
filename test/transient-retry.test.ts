import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, postJson, type Harness } from "./helpers.js";
import { POLICY } from "../src/state/policy.js";

describe("transient retry", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    h.stopSweep();
    await h.app.close();
    h.store.close();
  });

  it("two transient errors then success → IN_SYNC, failure_count cleared", async () => {
    await postJson(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      version: 1,
      config: { ssid: "v1" },
    });

    // Attempt 1: deliver apply, device returns transient error.
    let r = await postJson<{ instruction: string }>(
      h.app,
      "/v1/devices/d-01/checkin",
      { reportedVersion: null },
    );
    expect(r.body.instruction).toBe("apply");

    h.clock.advance(500);
    await postJson(h.app, "/v1/devices/d-01/checkin", {
      reportedVersion: null,
      lastApplyResult: { kind: "transient_error", reason: "tcp reset" },
    });
    let dev = h.store.getDevice("d-01")!;
    expect(dev.state).toBe("FAILED_TRANSIENT");
    expect(dev.failure_count).toBe(1);
    expect(dev.next_retry_at).not.toBeNull();
    const firstRetryAt = dev.next_retry_at!;
    expect(firstRetryAt - h.clock.now()).toBe(POLICY.baseBackoffMs);

    // Before backoff expires: server keeps it in noop.
    r = await postJson<{ instruction: string }>(
      h.app,
      "/v1/devices/d-01/checkin",
      { reportedVersion: null },
    );
    expect(r.body.instruction).toBe("noop");

    // Advance past backoff and try again — get apply instruction.
    h.clock.advance(POLICY.baseBackoffMs + 1);
    r = await postJson<{ instruction: string }>(
      h.app,
      "/v1/devices/d-01/checkin",
      { reportedVersion: null },
    );
    expect(r.body.instruction).toBe("apply");

    // Attempt 2: also fails transiently.
    await postJson(h.app, "/v1/devices/d-01/checkin", {
      reportedVersion: null,
      lastApplyResult: { kind: "transient_error", reason: "timeout" },
    });
    dev = h.store.getDevice("d-01")!;
    expect(dev.state).toBe("FAILED_TRANSIENT");
    expect(dev.failure_count).toBe(2);

    // Advance past second backoff (baseBackoff * 2 with no jitter — rng=0.5).
    h.clock.advance(POLICY.baseBackoffMs * 2 + 1);
    r = await postJson<{ instruction: string }>(
      h.app,
      "/v1/devices/d-01/checkin",
      { reportedVersion: null },
    );
    expect(r.body.instruction).toBe("apply");

    // Attempt 3: success.
    await postJson(h.app, "/v1/devices/d-01/checkin", {
      reportedVersion: 1,
      reportedConfig: { ssid: "v1" },
      lastApplyResult: {
        kind: "success",
        appliedVersion: 1,
        appliedConfig: { ssid: "v1" },
      },
    });
    dev = h.store.getDevice("d-01")!;
    expect(dev.state).toBe("IN_SYNC");
    expect(dev.failure_count).toBe(0);
    expect(dev.last_failure_reason).toBeNull();
  });
});
