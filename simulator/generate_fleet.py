"""Generate a 100-device fleet.yaml with a realistic mix of chaos profiles."""

from __future__ import annotations

import sys
from pathlib import Path


VENDORS = ["mikrotik", "cisco", "ubiquiti", "aruba", "ruckus"]
NETWORKS = ["lobby", "guest", "back-of-house", "rooftop", "garage"]


def main() -> None:
    out = Path(__file__).parent / "fleet.yaml"

    # Profile mix: most well-behaved, some flaky, a few often-offline, a sprinkle
    # of silent corruptors, and one permanently broken device so the
    # GIVE_UP / "needs human" rollup is visibly populated in the demo.
    mix = (
        [("well_behaved", n) for n in range(60)]
        + [("flaky", n) for n in range(25)]
        + [("often_offline", n) for n in range(10)]
        + [("silent_corruptor", n) for n in range(4)]
        + [("broken", n) for n in range(1)]
    )

    lines = [
        "# 100-device fleet, mixed chaos profiles. Regenerate with:",
        "#   python simulator/generate_fleet.py",
        "org: acme",
        "org_name: Acme Hospitality",
        "poll_interval_s: 60.0",
        "devices:",
    ]
    for i, (profile, _) in enumerate(mix):
        device_id = f"d-{i + 1:03d}"
        vendor = VENDORS[i % len(VENDORS)]
        lines.append(f"  - id: {device_id}")
        lines.append(f"    vendor: {vendor}")
        lines.append(f"    network_id: {NETWORKS[i % len(NETWORKS)]}")
        lines.append(f"    profile: {profile}")

    out.write_text("\n".join(lines) + "\n")
    sys.stdout.write(f"wrote {out} ({len(mix)} devices)\n")


if __name__ == "__main__":
    main()
