import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, postJson, type Harness } from "./helpers.js";

describe("happy path", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    h.stopSweep();
    await h.app.close();
    h.store.close();
  });

  it("ingest → checkin → apply → ack → IN_SYNC", async () => {
    const ingest = await postJson(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      vendor: "mikrotik",
      version: 1,
      config: { ssid: "guest" },
    });
    expect(ingest.status).toBe(202);

    const dev1 = h.store.getDevice("d-01")!;
    expect(dev1.state).toBe("PENDING");
    expect(dev1.desired_version).toBe(1);

    // First check-in: server should hand back the apply instruction.
    const checkin1 = await postJson<{
      instruction: string;
      targetVersion?: number;
      targetConfig?: Record<string, unknown>;
    }>(h.app, "/v1/devices/d-01/checkin", { reportedVersion: null });
    expect(checkin1.status).toBe(200);
    expect(checkin1.body.instruction).toBe("apply");
    expect(checkin1.body.targetVersion).toBe(1);
    expect(checkin1.body.targetConfig).toEqual({ ssid: "guest" });
    expect(h.store.getDevice("d-01")!.state).toBe("APPLYING");

    // Device confirms apply.
    h.clock.advance(500);
    const checkin2 = await postJson<{ instruction: string }>(
      h.app,
      "/v1/devices/d-01/checkin",
      {
        reportedVersion: 1,
        reportedConfig: { ssid: "guest" },
        lastApplyResult: {
          kind: "success",
          appliedVersion: 1,
          appliedConfig: { ssid: "guest" },
        },
      },
    );
    expect(checkin2.body.instruction).toBe("noop");

    const dev2 = h.store.getDevice("d-01")!;
    expect(dev2.state).toBe("IN_SYNC");
    expect(dev2.reported_version).toBe(1);
    expect(dev2.failure_count).toBe(0);
  });
});
