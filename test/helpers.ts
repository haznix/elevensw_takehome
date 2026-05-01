import { buildApp, type BuiltApp } from "../src/server.js";
import { sweep } from "../src/reconciler/sweep.js";

export class Clock {
  constructor(public ms = 1_700_000_000_000) {}
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface Harness extends BuiltApp {
  clock: Clock;
  rng: () => number;
  sweep(): ReturnType<typeof sweep>;
}

export function makeHarness(): Harness {
  const clock = new Clock();
  // Deterministic RNG (always returns 0.5 → no jitter, predictable backoff).
  const rng = () => 0.5;
  const built = buildApp({ now: clock.now, rng });
  return {
    ...built,
    clock,
    rng,
    sweep() {
      return sweep(built.store, clock.now(), { rng });
    },
  };
}

export async function postJson<T = unknown>(
  app: BuiltApp["app"],
  url: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method: "POST",
    url,
    payload: body,
    headers: { "content-type": "application/json" },
  });
  return { status: res.statusCode, body: res.json() as T };
}

export async function getJson<T = unknown>(
  app: BuiltApp["app"],
  url: string,
): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as T };
}
