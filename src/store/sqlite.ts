import Database from "better-sqlite3";
import { migrate } from "./migrate.js";
import type { Config, DeviceRow, DeviceState, StateLogRow } from "../types.js";

export class Store {
  readonly db: Database.Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  // ---- orgs ---------------------------------------------------------------

  upsertOrg(id: string, name?: string): void {
    this.db
      .prepare(
        `INSERT INTO orgs(id, name) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, orgs.name)`,
      )
      .run(id, name ?? null);
  }

  // ---- devices ------------------------------------------------------------

  getDevice(id: string): DeviceRow | undefined {
    return this.db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as
      | DeviceRow
      | undefined;
  }

  upsertDevice(input: {
    id: string;
    orgId: string;
    networkId?: string;
    vendor?: string;
    now: number;
  }): DeviceRow {
    const existing = this.getDevice(input.id);
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (input.vendor && input.vendor !== existing.vendor) patch.vendor = input.vendor;
      if (input.networkId !== undefined && input.networkId !== existing.network_id)
        patch.network_id = input.networkId;
      if (Object.keys(patch).length > 0) {
        const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
        this.db
          .prepare(`UPDATE devices SET ${sets} WHERE id = ?`)
          .run(...Object.values(patch), input.id);
      }
      return this.getDevice(input.id)!;
    }
    this.db
      .prepare(
        `INSERT INTO devices(
            id, org_id, network_id, vendor, state, failure_count, last_state_change_at
         ) VALUES (?, ?, ?, ?, 'IN_SYNC', 0, ?)`,
      )
      .run(
        input.id,
        input.orgId,
        input.networkId ?? null,
        input.vendor ?? null,
        input.now,
      );
    return this.getDevice(input.id)!;
  }

  getOrgName(orgId: string): string | null {
    const row = this.db
      .prepare(`SELECT name FROM orgs WHERE id = ?`)
      .get(orgId) as { name: string | null } | undefined;
    return row?.name ?? null;
  }

  listDevicesByOrg(orgId: string): DeviceRow[] {
    return this.db
      .prepare(`SELECT * FROM devices WHERE org_id = ? ORDER BY id`)
      .all(orgId) as DeviceRow[];
  }

  listAllDevices(): DeviceRow[] {
    return this.db.prepare(`SELECT * FROM devices ORDER BY id`).all() as DeviceRow[];
  }

  rollupByOrg(orgId: string): Record<DeviceState, number> {
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) as n FROM devices WHERE org_id = ? GROUP BY state`,
      )
      .all(orgId) as { state: DeviceState; n: number }[];
    const counts = {
      IN_SYNC: 0,
      PENDING: 0,
      APPLYING: 0,
      FAILED_TRANSIENT: 0,
      GIVE_UP: 0,
      DRIFTING: 0,
      OFFLINE: 0,
    } satisfies Record<DeviceState, number>;
    for (const r of rows) counts[r.state] = r.n;
    return counts;
  }

  updateDevice(id: string, patch: Partial<DeviceRow>): void {
    const keys = Object.keys(patch).filter((k) => k !== "id");
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
    this.db.prepare(`UPDATE devices SET ${sets} WHERE id = ?`).run(...values, id);
  }

  // ---- events -------------------------------------------------------------

  insertEvent(input: {
    deviceId: string;
    version: number;
    config: Config;
    now: number;
  }): { inserted: boolean } {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO events(device_id, version, config_json, received_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.deviceId,
        input.version,
        JSON.stringify(input.config),
        input.now,
      );
    return { inserted: res.changes === 1 };
  }

  // ---- state log ----------------------------------------------------------

  appendStateLog(input: {
    deviceId: string;
    fromState: DeviceState | null;
    toState: DeviceState;
    reason: string;
    at: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO state_log(device_id, from_state, to_state, reason, at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.deviceId,
        input.fromState,
        input.toState,
        input.reason,
        input.at,
      );
  }

  getStateLog(deviceId: string, limit = 100): StateLogRow[] {
    return this.db
      .prepare(
        `SELECT * FROM state_log WHERE device_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(deviceId, limit) as StateLogRow[];
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
