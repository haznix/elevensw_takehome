"""Chaos profiles applied to simulated devices.

Each Chaos config is consulted at well-defined points in the device loop:

  - Before sending the check-in HTTP call: timeout_rate may force a hang.
  - Inside the apply step: transient_error_rate / permanent_error_rate decide
    whether the apply 'succeeds', and apply_latency_ms simulates how long it
    physically takes.
  - After apply: post_apply_drift_rate may silently mutate the running config
    so a later check-in surfaces the divergence.
  - Before sending the check-in HTTP call: offline_windows can suppress all
    network activity for a period, simulating a device losing uplink.

Profile presets at the bottom give a quick way to populate fleet.yaml with
mixed behaviour.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field
from typing import Tuple


@dataclass
class Chaos:
    timeout_rate: float = 0.0
    transient_error_rate: float = 0.0
    permanent_error_rate: float = 0.0
    apply_latency_ms: Tuple[int, int] = (50, 200)
    offline_windows: list[Tuple[int, int]] = field(default_factory=list)
    """List of (epoch_start_ms, epoch_end_ms) windows during which the device
    refuses to talk to the server. Useful for scripted offline scenarios."""
    post_apply_drift_rate: float = 0.0

    def is_offline(self, now_ms: int | None = None) -> bool:
        now_ms = now_ms or int(time.time() * 1000)
        return any(s <= now_ms <= e for s, e in self.offline_windows)

    def roll_apply(self, rng: random.Random) -> str:
        """Return one of: 'success' | 'transient' | 'permanent'."""
        r = rng.random()
        if r < self.permanent_error_rate:
            return "permanent"
        if r < self.permanent_error_rate + self.transient_error_rate:
            return "transient"
        return "success"

    def should_drift(self, rng: random.Random) -> bool:
        return rng.random() < self.post_apply_drift_rate

    def should_timeout(self, rng: random.Random) -> bool:
        return rng.random() < self.timeout_rate

    def apply_delay_ms(self, rng: random.Random) -> int:
        lo, hi = self.apply_latency_ms
        return rng.randint(lo, hi)


PROFILES: dict[str, Chaos] = {
    "well_behaved": Chaos(),
    "flaky": Chaos(
        timeout_rate=0.05,
        transient_error_rate=0.20,
        apply_latency_ms=(100, 600),
    ),
    "often_offline": Chaos(
        timeout_rate=0.10,
        transient_error_rate=0.10,
    ),
    "silent_corruptor": Chaos(
        post_apply_drift_rate=0.30,
        apply_latency_ms=(50, 150),
    ),
    "broken": Chaos(
        permanent_error_rate=1.0,
    ),
}


def profile(name: str) -> Chaos:
    if name not in PROFILES:
        raise KeyError(f"unknown chaos profile: {name}")
    return PROFILES[name]
