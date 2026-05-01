import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, postJson, type Harness } from "./helpers.js";
import { POLICY } from "../src/state/policy.js";

describe("offline → return", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    h.stopSweep();
    await h.app.close();
    h.store.close();
  });

  it("device goes silent → OFFLINE; resumes → reconciles to IN_SYNC", async () => {
    await postJson(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      version: 1,
      config: { ssid: "v1" },
    });
    // First check-in just to register last_checkin_at.
    await postJson(h.app, "/v1/devices/d-01/checkin", { reportedVersion: null });
    // Server sent apply — state is APPLYING.
    expect(h.store.getDevice("d-01")!.state).toBe("APPLYING");

    // Time passes well beyond the heartbeat threshold with no check-ins.
    h.clock.advance(POLICY.heartbeatThresholdMs + 1_000);
    h.sweep();

    let dev = h.store.getDevice("d-01")!;
    expect(dev.state).toBe("OFFLINE");
    expect(dev.pre_offline_state).toBe("APPLYING");

    // Device returns. We expect: state restored, then reconcile pushes through.
    h.clock.advance(1_000);
    const r = await postJson<{ instruction: string }>(
      h.app,
      "/v1/devices/d-01/checkin",
      { reportedVersion: null },
    );
    // Device hasn't reported success → server re-sends apply.
    expect(r.body.instruction).toBe("apply");
    dev = h.store.getDevice("d-01")!;
    expect(dev.state).toBe("APPLYING");

    h.clock.advance(500);
    await postJson(h.app, "/v1/devices/d-01/checkin", {
      reportedVersion: 1,
      reportedConfig: { ssid: "v1" },
      lastApplyResult: {
        kind: "success",
        appliedVersion: 1,
        appliedConfig: { ssid: "v1" },
      },
    });
    expect(h.store.getDevice("d-01")!.state).toBe("IN_SYNC");
  });
});
