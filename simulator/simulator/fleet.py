"""Fleet runner: spin up many simulated devices from a YAML config.

Usage:

    python -m simulator.fleet --config fleet.yaml --target http://localhost:3000

The YAML schema:

    org: acme
    poll_interval_s: 2.0
    devices:
      - id: d-001
        vendor: mikrotik
        profile: well_behaved
      - id: d-002
        vendor: cisco
        profile: flaky

`profile` values match keys in simulator.chaos.PROFILES; pass `chaos:`
inline if you need fully custom values for a single device.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import yaml

from .chaos import Chaos, profile
from .device import Device


log = logging.getLogger("simulator.fleet")


@dataclass
class FleetConfig:
    org: str
    poll_interval_s: float
    devices: list[Device]

    @classmethod
    def load(cls, path: Path) -> "FleetConfig":
        raw = yaml.safe_load(path.read_text())
        org = raw["org"]
        org_name = raw.get("org_name")
        poll = float(raw.get("poll_interval_s", 2.0))
        devices: list[Device] = []
        for i, dev in enumerate(raw["devices"]):
            chaos = (
                _chaos_from_inline(dev["chaos"])
                if "chaos" in dev
                else profile(dev.get("profile", "well_behaved"))
            )
            devices.append(
                Device(
                    id=dev["id"],
                    org_id=org,
                    org_name=org_name,
                    network_id=dev.get("network_id"),
                    vendor=dev.get("vendor", "generic"),
                    chaos=chaos,
                    poll_interval_s=poll,
                    rng_seed=dev.get("seed", i),
                )
            )
        return cls(org=org, poll_interval_s=poll, devices=devices)


def _chaos_from_inline(raw: dict[str, Any]) -> Chaos:
    return Chaos(
        timeout_rate=float(raw.get("timeout_rate", 0.0)),
        transient_error_rate=float(raw.get("transient_error_rate", 0.0)),
        permanent_error_rate=float(raw.get("permanent_error_rate", 0.0)),
        apply_latency_ms=tuple(raw.get("apply_latency_ms", [50, 200])),
        offline_windows=[tuple(w) for w in raw.get("offline_windows", [])],
        post_apply_drift_rate=float(raw.get("post_apply_drift_rate", 0.0)),
    )


async def run(cfg: FleetConfig, base_url: str) -> None:
    stop = asyncio.Event()

    def _handle_signal() -> None:
        log.info("stop signal received")
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle_signal)
        except NotImplementedError:
            pass

    log.info("fleet starting: %d devices targeting %s", len(cfg.devices), base_url)
    async with httpx.AsyncClient() as client:
        tasks = [
            asyncio.create_task(d.run(client, base_url, stop), name=f"dev-{d.id}")
            for d in cfg.devices
        ]
        await stop.wait()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    log.info("fleet stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a simulated device fleet")
    parser.add_argument("--config", type=Path, required=True, help="path to fleet.yaml")
    parser.add_argument("--target", default="http://localhost:3000", help="reconciler base URL")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    cfg = FleetConfig.load(args.config)
    asyncio.run(run(cfg, args.target.rstrip("/")))


if __name__ == "__main__":
    main()
