import type { FastifyInstance } from "fastify";
import type { Store } from "../store/sqlite.js";
import type { DeviceRow, DeviceState } from "../types.js";
import { POLICY } from "../state/policy.js";

export function registerObservabilityRoutes(
  app: FastifyInstance,
  store: Store,
  now: () => number,
): void {
  app.get("/healthz", async () => ({ ok: true }));

  app.get<{ Params: { orgId: string } }>(
    "/v1/orgs/:orgId/devices",
    async (req) => {
      const ts = now();
      const orgName = store.getOrgName(req.params.orgId);
      const devices = store
        .listDevicesByOrg(req.params.orgId)
        .map((d) => view(d, ts, orgName));
      return { orgId: req.params.orgId, orgName, devices };
    },
  );

  app.get<{ Params: { orgId: string } }>(
    "/v1/orgs/:orgId/rollup",
    async (req) => {
      const ts = now();
      const counts = store.rollupByOrg(req.params.orgId);
      const devices = store.listDevicesByOrg(req.params.orgId);
      const oldestPendingAgeMs = devices
        .filter((d) => d.state === "PENDING")
        .reduce(
          (max, d) => Math.max(max, ts - d.last_state_change_at),
          0,
        );
      const giveUpDeviceIds = devices.filter((d) => d.state === "GIVE_UP").map((d) => d.id);
      return {
        orgId: req.params.orgId,
        total: devices.length,
        counts,
        oldestPendingAgeMs,
        needsHuman: giveUpDeviceIds,
        at: ts,
      };
    },
  );

  app.get<{ Params: { id: string } }>("/v1/devices/:id", async (req, reply) => {
    const ts = now();
    const device = store.getDevice(req.params.id);
    if (!device) {
      reply.status(404);
      return { error: "unknown_device" };
    }
    const orgName = store.getOrgName(device.org_id);
    return {
      ...view(device, ts, orgName),
      log: store.getStateLog(device.id, 50),
    };
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    const all = store.listAllDevices();
    const byState: Record<DeviceState, number> = {
      IN_SYNC: 0,
      PENDING: 0,
      APPLYING: 0,
      FAILED_TRANSIENT: 0,
      GIVE_UP: 0,
      DRIFTING: 0,
      OFFLINE: 0,
    };
    for (const d of all) byState[d.state] += 1;
    const lines = [
      "# HELP devices_by_state Number of devices in each reconciliation state.",
      "# TYPE devices_by_state gauge",
      ...Object.entries(byState).map(
        ([state, n]) => `devices_by_state{state="${state}"} ${n}`,
      ),
      "# HELP devices_total Total number of registered devices.",
      "# TYPE devices_total gauge",
      `devices_total ${all.length}`,
      "",
    ];
    return lines.join("\n");
  });

  app.get("/", async (_req, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    return DASHBOARD_HTML;
  });
}

function view(d: DeviceRow, ts: number, orgName: string | null) {
  return {
    id: d.id,
    orgId: d.org_id,
    orgName,
    networkId: d.network_id,
    vendor: d.vendor,
    state: d.state,
    desiredVersion: d.desired_version,
    reportedVersion: d.reported_version,
    failureCount: d.failure_count,
    lastFailureReason: d.last_failure_reason,
    lastCheckinAgeMs:
      d.last_checkin_at === null ? null : ts - d.last_checkin_at,
    nextRetryInMs:
      d.next_retry_at === null ? null : Math.max(0, d.next_retry_at - ts),
    lastStateChangeAgeMs: ts - d.last_state_change_at,
  };
}

const DASHBOARD_HTML = `<!doctype html>
<html><head>
<meta charset="utf-8" />
<title>Device Reconciler</title>
<style>
  body { font: 14px ui-monospace, Menlo, monospace; margin: 24px; color: #222; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  .controls { margin: 8px 0 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 4px 10px; border-bottom: 1px solid #eee; text-align: left; }
  th { background: #fafafa; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .IN_SYNC { background: #d1f7d1; color: #1a5e1a; }
  .PENDING { background: #fff3c4; color: #6b4f00; }
  .APPLYING { background: #cfe7ff; color: #064d8a; }
  .FAILED_TRANSIENT { background: #ffd9c2; color: #8a3a06; }
  .GIVE_UP { background: #ffc2c2; color: #8a0606; font-weight: bold; }
  .DRIFTING { background: #e8d4ff; color: #4a0d8a; }
  .OFFLINE { background: #e0e0e0; color: #555; }
  .rollup { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
  .rollup .box { padding: 8px 14px; border: 1px solid #ddd; border-radius: 6px; }
  .rollup .n { font-size: 22px; font-weight: bold; }
  .muted { color: #888; }
</style>
</head><body>
<h1>Device Reconciler</h1>
<div class="controls">
  Org: <input id="org" value="acme" />
  <button onclick="refresh()">Refresh</button>
  <span class="muted" id="updated"></span>
</div>
<div class="rollup" id="rollup"></div>
<table>
  <thead><tr>
    <th>org</th><th>network</th><th>device</th><th>state</th><th>desired</th><th>reported</th>
    <th>failures</th><th>last check-in</th><th>reason</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
<script>
async function refresh() {
  const org = document.getElementById('org').value || 'acme';
  try {
    const [r, l] = await Promise.all([
      fetch('/v1/orgs/' + org + '/rollup').then(x => x.json()),
      fetch('/v1/orgs/' + org + '/devices').then(x => x.json()),
    ]);
    const rollup = document.getElementById('rollup');
    rollup.innerHTML = Object.entries(r.counts).map(([s, n]) =>
      '<div class="box"><div class="muted">' + s + '</div><div class="n">' + n + '</div></div>'
    ).join('') + '<div class="box"><div class="muted">total</div><div class="n">' + r.total + '</div></div>';
    const rows = document.getElementById('rows');
    rows.innerHTML = (l.devices || []).map(d =>
      '<tr>' +
        '<td>' + (d.orgName || d.orgId) + '</td>' +
        '<td>' + (d.networkId || '<span class="muted">-</span>') + '</td>' +
        '<td>' + d.id + '</td>' +
        '<td><span class="pill ' + d.state + '">' + d.state + '</span></td>' +
        '<td>' + (d.desiredVersion ?? '-') + '</td>' +
        '<td>' + (d.reportedVersion ?? '-') + '</td>' +
        '<td>' + d.failureCount + '</td>' +
        '<td>' + (d.lastCheckinAgeMs == null ? '-' : Math.round(d.lastCheckinAgeMs / 1000) + 's ago') + '</td>' +
        '<td>' + (d.lastFailureReason || '') + '</td>' +
      '</tr>'
    ).join('');
    document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('updated').textContent = 'error: ' + e.message;
  }
}
refresh();
setInterval(refresh, 2000);
</script>
</body></html>`;

// Avoid "unused" complaint when policy isn't referenced directly here.
export { POLICY };
