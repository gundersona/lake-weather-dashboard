#!/usr/bin/env python3
"""Fetch lake surface areas from the USGS National Hydrography Dataset.

Queries the National Map NHD "Waterbody - Large Scale" ArcGIS REST service in
small batches of GNIS feature IDs (large IN-lists time out) with several
concurrent workers, and sums AREASQKM per ID (a named lake can be split into
multiple waterbody polygons).

Writes scripts/nhd_areas.json: { "<gnis_id>": <area_km2>, ... }
Progress is checkpointed to /tmp/nhd_areas_progress.json so a run can resume.
"""
from __future__ import annotations

import glob
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVICE = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12/query"
BATCH = 50
WORKERS = 8
PROGRESS = "/tmp/nhd_areas_progress.json"
OUT = os.path.join(ROOT, "scripts", "nhd_areas.json")


def all_gnis_ids() -> list[str]:
    ids: set[str] = set()
    for path in glob.glob(os.path.join(ROOT, "data", "lakes", "*.json")):
        if os.path.basename(path) == "index.json":
            continue
        for lake in json.load(open(path)):
            ids.add(lake["id"].rsplit("-", 1)[1])
    return sorted(ids)


def query_batch(padded_ids: list[str]) -> dict:
    in_list = ",".join(f"'{i}'" for i in padded_ids)
    params = {
        "where": f"GNIS_ID IN ({in_list})",
        "outFields": "GNIS_ID,AREASQKM",
        "returnGeometry": "false",
        "f": "json",
    }
    url = SERVICE + "?" + urllib.parse.urlencode(params)
    last_err = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "lake-weather-dashboard/1.0"})
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.load(resp)
            if data.get("error"):
                raise RuntimeError(data["error"])
            return data
        except Exception as e:  # noqa: BLE001 - retry transient failures
            last_err = e
            time.sleep(2**attempt)
    raise RuntimeError(f"batch failed after retries: {last_err}")


def main() -> int:
    ids = all_gnis_ids()
    print(f"{len(ids)} unique GNIS ids to look up", flush=True)

    areas: dict[str, float] = {}
    done: set[str] = set()
    if os.path.exists(PROGRESS):
        saved = json.load(open(PROGRESS))
        areas = saved["areas"]
        done = set(saved["done"])
        print(f"resuming: {len(done)} already done", flush=True)

    todo = [i for i in ids if i not in done]
    chunks = [todo[i : i + BATCH] for i in range(0, len(todo), BATCH)]
    print(f"{len(chunks)} batches x {WORKERS} workers", flush=True)

    lock = threading.Lock()
    completed = 0

    def work(chunk: list[str]) -> None:
        nonlocal completed
        padded = [c.zfill(8) for c in chunk]
        data = query_batch(padded)
        local: dict[str, float] = {}
        for feat in data.get("features", []):
            attrs = feat["attributes"]
            gid = str(attrs["GNIS_ID"]).lstrip("0") or "0"
            a = attrs.get("AREASQKM")
            if a is None:
                continue
            local[gid] = local.get(gid, 0.0) + float(a)
        with lock:
            for gid, a in local.items():
                areas[gid] = areas.get(gid, 0.0) + a
            done.update(chunk)
            completed += 1
            if completed % 25 == 0:
                json.dump({"areas": areas, "done": sorted(done)}, open(PROGRESS, "w"))
                print(
                    f"  {len(done)}/{len(ids)} ids queried, {len(areas)} with area",
                    flush=True,
                )

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(work, chunks))

    json.dump(areas, open(OUT, "w"))
    if os.path.exists(PROGRESS):
        os.remove(PROGRESS)
    print(f"done: {len(areas)}/{len(ids)} ids matched ({100*len(areas)/len(ids):.1f}%)", flush=True)
    print(f"wrote {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
