import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, postJson, type Harness } from "./helpers.js";

describe("idempotent re-delivery", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    h.stopSweep();
    await h.app.close();
    h.store.close();
  });

  it("duplicate event publish is acked, doesn't double-advance state", async () => {
    const first = await postJson<{ status: string }>(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      version: 1,
      config: { ssid: "v1" },
    });
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("accepted");

    const second = await postJson<{ status: string }>(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      version: 1,
      config: { ssid: "v1" },
    });
    expect(second.status).toBe(202);
    expect(second.body.status).toBe("duplicate");

    // Only one event row, only one PENDING transition entry in the log.
    const log = h.store.getStateLog("d-01");
    const pendingEntries = log.filter((l) => l.to_state === "PENDING");
    expect(pendingEntries.length).toBe(1);
  });

  it("device re-checks-in (response lost) — apply replayed, no double counting", async () => {
    await postJson(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      version: 1,
      config: { ssid: "v1" },
    });
    // First check-in: receive apply, response gets lost on the wire.
    const r1 = await postJson<{ instruction: string }>(
      h.app,
      "/v1/devices/d-01/checkin",
      { reportedVersion: null },
    );
    expect(r1.body.instruction).toBe("apply");
    expect(h.store.getDevice("d-01")!.state).toBe("APPLYING");

    // Same effective check-in re-issued by the device since it didn't see a reply.
    h.clock.advance(200);
    const r2 = await postJson<{ instruction: string }>(
      h.app,
      "/v1/devices/d-01/checkin",
      { reportedVersion: null },
    );
    // Same instruction returned — devices are responsible for being idempotent on apply.
    expect(r2.body.instruction).toBe("apply");
    const dev = h.store.getDevice("d-01")!;
    expect(dev.state).toBe("APPLYING");
    expect(dev.failure_count).toBe(0);

    // Device finally gets the reply and applies it once.
    h.clock.advance(200);
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
