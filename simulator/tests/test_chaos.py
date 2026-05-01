"""Sanity tests for the chaos profile primitives.

Not exhaustive — the simulator is exploratory by design — but enough to keep
the basic invariants honest under refactors.
"""

from __future__ import annotations

import random

import pytest

from simulator.chaos import Chaos, profile, PROFILES


def test_well_behaved_never_fails():
    rng = random.Random(0)
    c = profile("well_behaved")
    outcomes = {c.roll_apply(rng) for _ in range(1000)}
    assert outcomes == {"success"}


def test_broken_always_permanent():
    rng = random.Random(0)
    c = profile("broken")
    outcomes = {c.roll_apply(rng) for _ in range(1000)}
    assert outcomes == {"permanent"}


def test_flaky_produces_mixed_outcomes():
    rng = random.Random(0)
    c = profile("flaky")
    counts = {"success": 0, "transient": 0, "permanent": 0}
    for _ in range(2000):
        counts[c.roll_apply(rng)] += 1
    # Loose bounds — we just want to see meaningful diversity.
    assert counts["success"] > 1000
    assert counts["transient"] > 200


def test_offline_window_detection():
    c = Chaos(offline_windows=[(1000, 2000)])
    assert c.is_offline(now_ms=500) is False
    assert c.is_offline(now_ms=1500) is True
    assert c.is_offline(now_ms=2500) is False


def test_drift_rate_zero_means_no_drift():
    rng = random.Random(0)
    c = Chaos()
    assert all(c.should_drift(rng) is False for _ in range(1000))


def test_unknown_profile_raises():
    with pytest.raises(KeyError):
        profile("does-not-exist")


def test_all_profiles_are_chaos_instances():
    assert all(isinstance(c, Chaos) for c in PROFILES.values())
