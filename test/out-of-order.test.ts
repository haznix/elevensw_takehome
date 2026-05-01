import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, postJson, type Harness } from "./helpers.js";

describe("out-of-order events", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    h.stopSweep();
    await h.app.close();
    h.store.close();
  });

  it("v3 then v2: v2 is rejected as stale, desired stays at v3", async () => {
    const v3 = await postJson(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      version: 3,
      config: { ssid: "v3" },
    });
    expect(v3.status).toBe(202);

    const v2 = await postJson<{ status: string; currentDesiredVersion: number }>(
      h.app,
      "/v1/events",
      {
        orgId: "acme",
        deviceId: "d-01",
        version: 2,
        config: { ssid: "v2" },
      },
    );
    expect(v2.status).toBe(409);
    expect(v2.body.status).toBe("stale");
    expect(v2.body.currentDesiredVersion).toBe(3);

    const dev = h.store.getDevice("d-01")!;
    expect(dev.desired_version).toBe(3);
    expect(JSON.parse(dev.desired_config_json!)).toEqual({ ssid: "v3" });

    const log = h.store.getStateLog("d-01");
    expect(log.some((l) => l.reason.includes("ignored_stale_version v2"))).toBe(true);
  });

  it("v3 supersedes an in-flight v2 apply", async () => {
    await postJson(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      version: 2,
      config: { ssid: "v2" },
    });
    // Drive into APPLYING.
    await postJson(h.app, "/v1/devices/d-01/checkin", { reportedVersion: null });
    expect(h.store.getDevice("d-01")!.state).toBe("APPLYING");

    // Newer event lands while we're applying v2.
    await postJson(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      version: 3,
      config: { ssid: "v3" },
    });

    const dev = h.store.getDevice("d-01")!;
    expect(dev.state).toBe("PENDING");
    expect(dev.desired_version).toBe(3);
    expect(dev.failure_count).toBe(0);
    const log = h.store.getStateLog("d-01");
    expect(log.some((l) => l.reason.includes("supersedes in-flight"))).toBe(true);
  });
});
