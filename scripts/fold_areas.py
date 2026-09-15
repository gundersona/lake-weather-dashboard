#!/usr/bin/env python3
"""Fold NHD surface areas into the per-state lake JSON files.

Reads scripts/nhd_areas.json ({gnis_id: area_km2}) and adds an `area_km2`
field to each matching lake in data/lakes/<state>.json. Idempotent.
"""
from __future__ import annotations

import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AREAS_PATH = os.path.join(ROOT, "scripts", "nhd_areas.json")


def main() -> int:
    if not os.path.exists(AREAS_PATH):
        print(f"missing {AREAS_PATH} - run fetch_nhd_areas.py first", file=sys.stderr)
        return 1
    areas = json.load(open(AREAS_PATH))
    total = matched = 0
    for path in sorted(glob.glob(os.path.join(ROOT, "data", "lakes", "*.json"))):
        if os.path.basename(path) == "index.json":
            continue
        lakes = json.load(open(path))
        n = 0
        for lake in lakes:
            fid = lake["id"].rsplit("-", 1)[1]
            if fid in areas:
                lake["area_km2"] = round(areas[fid], 4)
                n += 1
        with open(path, "w", encoding="utf-8") as f:
            json.dump(lakes, f, ensure_ascii=False)
        total += len(lakes)
        matched += n
        print(f"{os.path.basename(path)}: {n}/{len(lakes)} with area")
    print(f"total: {matched}/{total} lakes have area ({100*matched/total:.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
