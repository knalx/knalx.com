#!/usr/bin/env python3
"""
Build public/stars.bin from a HYG CSV (https://astronexus.com/projects/hyg).
Filters to visible magnitude <= 5.5, keeps RA / Dec / mag / B-V, and
quantizes each field to a Uint16 — 8 bytes per star, ~14 KB total.

  curl -sL -o scripts/hyg.csv \\
    https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv
  python3 scripts/build-star-catalog.py

HYG data is CC-BY-SA. Attribution lives in public/index.html under the
aurora-credit line. Update there if the source changes.
"""
import csv
import struct
import sys
from pathlib import Path

SRC = Path("scripts/hyg.csv")
OUT = Path("public/stars.bin")
MAG_CUTOFF = 6.5  # naked-eye visibility limit; ~6000 stars from HYG


def q16(v: float, lo: float, hi: float) -> int:
    t = (v - lo) / (hi - lo)
    return max(0, min(65535, round(t * 65535)))


def main() -> int:
    if not SRC.exists():
        print(f"missing {SRC} — download HYG first (see docstring)", file=sys.stderr)
        return 1
    with SRC.open() as f:
        reader = csv.DictReader(f)
        stars = []
        for row in reader:
            try:
                mag = float(row["mag"])
            except (TypeError, ValueError):
                continue
            if mag > MAG_CUTOFF or mag < -10:  # row id=0 (Sol) has mag -26.7
                continue
            try:
                ra_hours = float(row["ra"])  # HYG ra is in hours, 0..24
                dec = float(row["dec"])  # degrees, -90..+90
            except (TypeError, ValueError):
                continue
            try:
                ci = float(row["ci"])
            except (TypeError, ValueError):
                ci = 0.6  # solar-ish if missing
            stars.append(
                (
                    q16(ra_hours * 15.0, 0.0, 360.0),
                    q16(dec, -90.0, 90.0),
                    q16(mag, -2.0, 6.0),
                    q16(ci, -0.5, 2.5),
                )
            )

    print(f"stars after filter (mag <= {MAG_CUTOFF}): {len(stars)}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("wb") as f:
        for ra, dec, mag, bv in stars:
            f.write(struct.pack("<HHHH", ra, dec, mag, bv))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
