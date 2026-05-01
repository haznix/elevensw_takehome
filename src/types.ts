export const STATES = [
  "IN_SYNC",
  "PENDING",
  "APPLYING",
  "FAILED_TRANSIENT",
  "GIVE_UP",
  "DRIFTING",
  "OFFLINE",
] as const;
export type DeviceState = (typeof STATES)[number];

export type Config = Record<string, unknown>;

export interface DeviceRow {
  id: string;
  org_id: string;
  network_id: string | null;
  vendor: string | null;
  desired_version: number | null;
  desired_config_json: string | null;
  reported_version: number | null;
  reported_config_json: string | null;
  state: DeviceState;
  failure_count: number;
  last_failure_reason: string | null;
  next_retry_at: number | null;
  last_checkin_at: number | null;
  last_state_change_at: number;
  pre_offline_state: DeviceState | null;
}

export interface IngestEvent {
  orgId: string;
  orgName?: string;
  networkId?: string;
  deviceId: string;
  vendor?: string;
  version: number;
  config: Config;
}

export type ApplyResult =
  | { kind: "success"; appliedVersion: number; appliedConfig: Config }
  | { kind: "transient_error"; reason: string }
  | { kind: "permanent_error"; reason: string };

export interface CheckinRequest {
  reportedVersion: number | null;
  reportedConfig?: Config;
  lastApplyResult?: ApplyResult;
}

export type CheckinResponse =
  | { instruction: "noop" }
  | { instruction: "apply"; targetVersion: number; targetConfig: Config };

export interface StateLogRow {
  id: number;
  device_id: string;
  from_state: DeviceState | null;
  to_state: DeviceState;
  reason: string;
  at: number;
}
