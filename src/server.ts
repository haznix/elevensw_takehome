import Fastify from "fastify";
import { Store } from "./store/sqlite.js";
import { registerEventRoutes } from "./api/events.js";
import { registerCheckinRoutes } from "./api/checkin.js";
import { registerObservabilityRoutes } from "./api/observability.js";
import { startSweepLoop } from "./reconciler/sweep.js";
import { log } from "./log.js";

export interface BuildOptions {
  dbPath?: string;
  now?: () => number;
  rng?: () => number;
}

export interface BuiltApp {
  app: ReturnType<typeof Fastify>;
  store: Store;
  stopSweep: () => void;
}

export function buildApp(opts: BuildOptions = {}): BuiltApp {
  const now = opts.now ?? (() => Date.now());
  const rng = opts.rng;
  const store = new Store(opts.dbPath ?? ":memory:");
  const app = Fastify({ logger: false });

  registerEventRoutes(app, store, now);
  registerCheckinRoutes(app, store, now, { rng });
  registerObservabilityRoutes(app, store, now);

  const sweepHandle = startSweepLoop(store, now, { rng });

  return { app, store, stopSweep: sweepHandle.stop };
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const dbPath = process.env.DB_PATH ?? "data.db";
  const { app, store, stopSweep } = buildApp({ dbPath });

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    stopSweep();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port, host: "0.0.0.0" });
  log.info({ port, dbPath }, "device-reconciler listening");
}

const isEntrypoint = (() => {
  try {
    const argvUrl = new URL(`file://${process.argv[1]}`).href;
    return import.meta.url === argvUrl;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  void main();
}
