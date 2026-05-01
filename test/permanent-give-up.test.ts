import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, postJson, type Harness } from "./helpers.js";
import { POLICY } from "../src/state/policy.js";

describe("give-up paths", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    h.stopSweep();
    await h.app.close();
    h.store.close();
  });

  it("permanent error → GIVE_UP immediately, no further apply instructions", async () => {
    await postJson(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      version: 1,
      config: { ssid: "v1" },
    });

    // Deliver apply.
    await postJson(h.app, "/v1/devices/d-01/checkin", { reportedVersion: null });

    // Device reports permanent failure.
    await postJson(h.app, "/v1/devices/d-01/checkin", {
      reportedVersion: null,
      lastApplyResult: { kind: "permanent_error", reason: "schema invalid" },
    });

    let dev = h.store.getDevice("d-01")!;
    expect(dev.state).toBe("GIVE_UP");
    expect(dev.last_failure_reason).toContain("schema invalid");

    // Subsequent check-ins get noop — no auto-retry.
    const r = await postJson<{ instruction: string }>(
      h.app,
      "/v1/devices/d-01/checkin",
      { reportedVersion: null },
    );
    expect(r.body.instruction).toBe("noop");
    dev = h.store.getDevice("d-01")!;
    expect(dev.state).toBe("GIVE_UP");
  });

  it("transient errors past max attempts → GIVE_UP", async () => {
    await postJson(h.app, "/v1/events", {
      orgId: "acme",
      deviceId: "d-01",
      version: 1,
      config: { ssid: "v1" },
    });

    for (let attempt = 1; attempt <= POLICY.maxAttempts; attempt++) {
      // Get the apply instruction.
      await postJson(h.app, "/v1/devices/d-01/checkin", { reportedVersion: null });
      // Report transient error.
      await postJson(h.app, "/v1/devices/d-01/checkin", {
        reportedVersion: null,
        lastApplyResult: { kind: "transient_error", reason: `attempt ${attempt}` },
      });
      // Skip past the backoff window for the next iteration.
      h.clock.advance(POLICY.maxBackoffMs + 1);
    }

    const dev = h.store.getDevice("d-01")!;
    expect(dev.state).toBe("GIVE_UP");
    expect(dev.failure_count).toBe(POLICY.maxAttempts);
    expect(dev.next_retry_at).toBeNull();

    // Rollup surfaces it under needsHuman.
    const rollup = await fetchJson<{
      needsHuman: string[];
      counts: Record<string, number>;
    }>(h, "/v1/orgs/acme/rollup");
    expect(rollup.needsHuman).toContain("d-01");
    expect(rollup.counts.GIVE_UP).toBe(1);
  });
});

async function fetchJson<T>(h: Harness, url: string): Promise<T> {
  const res = await h.app.inject({ method: "GET", url });
  return res.json() as T;
}
