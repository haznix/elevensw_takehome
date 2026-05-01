import type Database from "better-sqlite3";

export function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS orgs (
      id   TEXT PRIMARY KEY,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      id                     TEXT PRIMARY KEY,
      org_id                 TEXT NOT NULL REFERENCES orgs(id),
      network_id             TEXT,
      vendor                 TEXT,
      desired_version        INTEGER,
      desired_config_json    TEXT,
      reported_version       INTEGER,
      reported_config_json   TEXT,
      state                  TEXT NOT NULL,
      failure_count          INTEGER NOT NULL DEFAULT 0,
      last_failure_reason    TEXT,
      next_retry_at          INTEGER,
      last_checkin_at        INTEGER,
      last_state_change_at   INTEGER NOT NULL,
      pre_offline_state      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_devices_org     ON devices(org_id);
    CREATE INDEX IF NOT EXISTS idx_devices_network ON devices(network_id);
    CREATE INDEX IF NOT EXISTS idx_devices_state   ON devices(state);

    CREATE TABLE IF NOT EXISTS events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id    TEXT NOT NULL,
      version      INTEGER NOT NULL,
      config_json  TEXT NOT NULL,
      received_at  INTEGER NOT NULL,
      UNIQUE(device_id, version)
    );

    CREATE TABLE IF NOT EXISTS state_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id  TEXT NOT NULL,
      from_state TEXT,
      to_state   TEXT NOT NULL,
      reason     TEXT NOT NULL,
      at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_state_log_device ON state_log(device_id, at);
  `);

  // Incremental migrations for databases that pre-date a column.
  ensureColumn(db, "devices", "network_id", "TEXT");
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
