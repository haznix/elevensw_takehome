import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, postJson, type Harness } from "./helpers.js";

describe("drift detection", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    h.stopSweep();
    await h.app.close();
    h.store.close();
  });

  it("post-apply drift → DRIFTING → re-apply → IN_SYNC", async () => {
    await postJson(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      version: 1,
      config: { ssid: "guest" },
    });
    await postJson(h.app, "/v1/devices/d-01/checkin", { reportedVersion: null });
    await postJson(h.app, "/v1/devices/d-01/checkin", {
      reportedVersion: 1,
      reportedConfig: { ssid: "guest" },
      lastApplyResult: {
        kind: "success",
        appliedVersion: 1,
        appliedConfig: { ssid: "guest" },
      },
    });
    expect(h.store.getDevice("d-01")!.state).toBe("IN_SYNC");

    // Someone SSH'd into the device and changed SSID. Next check-in surfaces it.
    h.clock.advance(5_000);
    const r = await postJson<{ instruction: string; targetConfig?: unknown }>(
      h.app,
      "/v1/devices/d-01/checkin",
      {
        reportedVersion: 1,
        reportedConfig: { ssid: "manually-changed" },
      },
    );
    // Drift detected on this very check-in: server re-issues apply.
    expect(h.store.getDevice("d-01")!.state).toBe("APPLYING");
    expect(r.body.instruction).toBe("apply");
    expect(r.body.targetConfig).toEqual({ ssid: "guest" });

    // State log shows DRIFTING was passed through.
    const log = h.store.getStateLog("d-01");
    expect(log.some((l) => l.to_state === "DRIFTING")).toBe(true);

    // Device re-applies.
    h.clock.advance(500);
    await postJson(h.app, "/v1/devices/d-01/checkin", {
      reportedVersion: 1,
      reportedConfig: { ssid: "guest" },
      lastApplyResult: {
        kind: "success",
        appliedVersion: 1,
        appliedConfig: { ssid: "guest" },
      },
    });
    expect(h.store.getDevice("d-01")!.state).toBe("IN_SYNC");
  });
});
