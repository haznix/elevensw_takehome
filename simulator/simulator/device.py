"""A single simulated device.

The device runs a periodic check-in loop. Each loop iteration:

  1. If we're inside an offline window, do nothing this tick.
  2. Send a check-in to /v1/devices/{id}/checkin reporting our current state
     (and any pending apply ack from the previous tick).
  3. If the server replies with an 'apply' instruction, simulate applying it
     (with chaos-driven success / transient / permanent outcome) and stash the
     result to send on the *next* check-in. This intentionally mirrors a real
     two-phase apply where the device acknowledges asynchronously.

Apply ack is sent on the *next* check-in (rather than immediately re-checking
in) to keep the loop cadence stable and exercise the server's APPLYING-timeout
sweep on stuck devices.
"""

from __future__ import annotations

import asyncio
import logging
import random
from dataclasses import dataclass, field
from typing import Any

import httpx

from .chaos import Chaos


log = logging.getLogger("simulator.device")


@dataclass
class Device:
    id: str
    org_id: str
    vendor: str
    chaos: Chaos
    poll_interval_s: float = 2.0
    rng_seed: int | None = None
    org_name: str | None = None
    network_id: str | None = None

    # Local state (what the device thinks it has).
    reported_version: int | None = None
    reported_config: dict[str, Any] | None = None
    pending_ack: dict[str, Any] | None = None

    rng: random.Random = field(init=False)

    def __post_init__(self) -> None:
        self.rng = random.Random(self.rng_seed)

    async def run(self, client: httpx.AsyncClient, base_url: str, stop: asyncio.Event) -> None:
        url = f"{base_url}/v1/devices/{self.id}/checkin"
        # Stagger so 100 devices don't all hit the server in lockstep.
        await asyncio.sleep(self.rng.random() * self.poll_interval_s)
        while not stop.is_set():
            try:
                await self._tick(client, url)
            except Exception as exc:  # noqa: BLE001 — we want simulator robustness
                log.warning("device %s tick failed: %s", self.id, exc)
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.poll_interval_s)
                return
            except asyncio.TimeoutError:
                pass

    async def _tick(self, client: httpx.AsyncClient, url: str) -> None:
        if self.chaos.is_offline():
            return
        if self.chaos.should_timeout(self.rng):
            # Simulate a hung connection by skipping the request entirely; this
            # is what the server perceives — no check-in this tick.
            return

        body: dict[str, Any] = {
            "orgId": self.org_id,
            "vendor": self.vendor,
            "reportedVersion": self.reported_version,
        }
        if self.org_name is not None:
            body["orgName"] = self.org_name
        if self.network_id is not None:
            body["networkId"] = self.network_id
        if self.reported_config is not None:
            body["reportedConfig"] = self.reported_config
        if self.pending_ack is not None:
            body["lastApplyResult"] = self.pending_ack
            self.pending_ack = None

        try:
            resp = await client.post(url, json=body, timeout=5.0)
        except httpx.HTTPError as exc:
            log.debug("device %s: network error %s", self.id, exc)
            return

        if resp.status_code != 200:
            log.warning("device %s: server replied %s: %s", self.id, resp.status_code, resp.text)
            return

        data = resp.json()
        instruction = data.get("instruction")
        if instruction == "apply":
            await self._apply(data["targetVersion"], data["targetConfig"])

    async def _apply(self, target_version: int, target_config: dict[str, Any]) -> None:
        outcome = self.chaos.roll_apply(self.rng)
        delay = self.chaos.apply_delay_ms(self.rng) / 1000.0
        await asyncio.sleep(delay)

        if outcome == "permanent":
            self.pending_ack = {
                "kind": "permanent_error",
                "reason": "device rejected config (simulated)",
            }
            return
        if outcome == "transient":
            self.pending_ack = {
                "kind": "transient_error",
                "reason": "transient apply failure (simulated)",
            }
            return

        # Success path.
        self.reported_version = target_version
        self.reported_config = dict(target_config)

        if self.chaos.should_drift(self.rng):
            # Mutate the running config silently — a later check-in will report
            # this divergence and the server should mark the device DRIFTING.
            drifted = dict(target_config)
            drifted["__drift_marker"] = self.rng.randint(1, 1_000_000)
            self.reported_config = drifted

        self.pending_ack = {
            "kind": "success",
            "appliedVersion": target_version,
            "appliedConfig": dict(target_config),
        }
