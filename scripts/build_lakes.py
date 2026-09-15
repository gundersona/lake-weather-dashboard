#!/usr/bin/env python3
"""
build_lakes.py — Build the full US lake dataset for the Lake Weather Dashboard.

Pipeline:
  1. Download the USGS GNIS "DomesticNames National" pipe-delimited text file
     (inside a zip) from the National Map staged products bucket.
  2. Keep only FEATURE_CLASS in {"Lake", "Reservoir"}.
  3. Write one JSON file per state to data/lakes/<st>.json (lowercase state
     code), each a list of {id, name, state, county, lat, lon}.
  4. Regenerate data/lakes/index.json mapping state codes to file names.

If the download fails (network blocked, URL moved, …) the script prints
manual instructions pointing at the USGS download page instead of crashing
silently.

Usage:
  python3 scripts/build_lakes.py [--input PATH] [--out DIR] [--max-per-state N]

The GNIS national file is large (~hundreds of MB unzipped); expect the
download + parse to take a few minutes.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

GNIS_ZIP_URL = (
    "https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/"
    "DomesticNames/DomesticNames_National_Text.zip"
)
GNIS_DOWNLOAD_PAGE = "https://www.usgs.gov/us-board-on-geographic-names/download-gnis-data"

# GNIS feature classes we treat as lakes.
LAKE_CLASSES = {"Lake", "Reservoir"}

# Column positions in the GNIS pipe-delimited national file (header):
#   feature_id|feature_name|feature_class|state_name|state_numeric|county_name|
#   county_numeric|map_name|date_created|date_edited|bgn_type|bgn_authority|
#   bgn_date|prim_lat_dms|prim_long_dms|prim_lat_dec|prim_long_dec|
#   source_lat_dms|source_long_dms|source_lat_dec|source_long_dec
COL_FEATURE_ID = 0
COL_FEATURE_NAME = 1
COL_FEATURE_CLASS = 2
COL_STATE_NAME = 3
COL_COUNTY_NAME = 5
COL_LAT_DEC = 15
COL_LON_DEC = 16

# GNIS state_name -> USPS alpha code (dashboard covers the 50 states).
STATE_NAME_TO_ALPHA = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
    "California": "CA", "Colorado": "CO", "Connecticut": "CT",
    "Delaware": "DE", "Florida": "FL", "Georgia": "GA", "Hawaii": "HI",
    "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
    "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME",
    "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI",
    "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO",
    "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
    "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
    "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
    "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR",
    "Pennsylvania": "PA", "Rhode Island": "RI",
    "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN",
    "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA",
    "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI",
    "Wyoming": "WY",
}


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "lake"


def download_gnis_zip(dest: Path) -> None:
    """Download the GNIS national zip. Raises on failure."""
    print(f"Downloading GNIS national file from:\n  {GNIS_ZIP_URL}")
    req = urllib.request.Request(GNIS_ZIP_URL, headers={"User-Agent": "lake-weather-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as f:
        total = int(resp.headers.get("Content-Length", 0) or 0)
        done = 0
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1024 / 1024:.1f} / {total / 1024 / 1024:.1f} MB", end="", flush=True)
        print()


def print_manual_instructions(zip_path: Path | None) -> None:
    print(
        "\nAutomatic download failed. You can still build the dataset manually:\n"
        f"  1. Visit {GNIS_DOWNLOAD_PAGE}\n"
        "  2. Download the \"National File\" (pipe-delimited text, inside a .zip).\n"
        "  3. Re-run this script pointing at the file you downloaded:\n"
        "       python3 scripts/build_lakes.py --input /path/to/DomesticNames_National.txt\n"
        "     (or --input /path/to/the.zip — a zip is detected automatically)\n",
        file=sys.stderr,
    )
    if zip_path and zip_path.exists():
        print(f"  (a partial download may exist at {zip_path}; delete it before retrying)",
              file=sys.stderr)


def iter_gnis_rows(path: Path):
    """Yield dict rows from the GNIS pipe-delimited national text file."""
    # The national file is encoded in a Windows-compatible encoding, with a few
    # stray bytes that decode as neither cp1252 nor UTF-8; replace those rather
    # than crashing.
    with open(path, "r", encoding="cp1252", errors="replace", newline="") as f:
        reader = csv.reader(f, delimiter="|")
        header = next(reader, None)
        if header:
            print(f"  columns: {len(header)} (expecting >= 11)")
        for row in reader:
            if len(row) <= COL_LON_DEC:
                continue
            yield row


def parse_lakes(path: Path, max_per_state: int | None):
    """Parse the national file into {STATE: [lake dicts]}."""
    by_state: dict[str, list[dict]] = {}
    seen_ids: set[str] = set()
    kept = skipped = bad_state = 0

    for row in iter_gnis_rows(path):
        if row[COL_FEATURE_CLASS] not in LAKE_CLASSES:
            skipped += 1
            continue
        fid = row[COL_FEATURE_ID]
        if fid in seen_ids:
            continue  # same feature listed under another county/state
        seen_ids.add(fid)

        state = STATE_NAME_TO_ALPHA.get(row[COL_STATE_NAME].strip())
        if not state:
            bad_state += 1
            continue
        try:
            lat = float(row[COL_LAT_DEC])
            lon = float(row[COL_LON_DEC])
        except ValueError:
            continue
        name = row[COL_FEATURE_NAME].strip()
        county = row[COL_COUNTY_NAME].strip()

        lake = {
            "id": f"{state.lower()}-{slugify(name)}-{fid}",
            "name": name,
            "state": state,
            "county": county,
            "lat": round(lat, 5),
            "lon": round(lon, 5),
        }
        by_state.setdefault(state, []).append(lake)
        kept += 1

    for state in by_state:
        by_state[state].sort(key=lambda l: l["name"].lower())
        if max_per_state is not None:
            by_state[state] = by_state[state][:max_per_state]

    print(f"  kept {kept} lake/reservoir features "
          f"({skipped} non-lake rows skipped, {bad_state} outside the 50 states, "
          f"{len(seen_ids)} unique ids)")
    return by_state


def write_output(by_state: dict[str, list[dict]], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    # Merge NHD surface areas when available (scripts/nhd_areas.json).
    areas = {}
    areas_path = Path(__file__).resolve().parent / "nhd_areas.json"
    if areas_path.exists():
        areas = json.loads(areas_path.read_text(encoding="utf-8"))
        print(f"  merging NHD surface areas for {len(areas)} features")
    index = {"states": {}}
    total = 0
    for state in sorted(by_state):
        lakes = by_state[state]
        if not lakes:
            continue
        if areas:
            for lake in lakes:
                fid = lake["id"].rsplit("-", 1)[1]
                if fid in areas:
                    lake["area_km2"] = round(areas[fid], 4)
        fname = f"{state.lower()}.json"
        with open(out_dir / fname, "w", encoding="utf-8") as f:
            json.dump(lakes, f, ensure_ascii=False)
        size_kb = (out_dir / fname).stat().st_size / 1024
        print(f"  wrote {fname}: {len(lakes)} lakes ({size_kb:.0f} KB)")
        index["states"][state] = fname
        total += len(lakes)

    with open(out_dir / "index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"  wrote index.json: {len(index['states'])} states, {total} lakes total")


def resolve_input(input_arg: str | None, tmpdir: Path) -> Path:
    """Return the path of the extracted national .txt file."""
    if input_arg:
        p = Path(input_arg)
        if not p.exists():
            raise FileNotFoundError(f"input file not found: {p}")
        if p.suffix.lower() == ".zip" or zipfile.is_zipfile(p):
            return extract_txt_from_zip(p, tmpdir)
        return p

    zip_path = tmpdir / "DomesticNames_National_Text.zip"
    try:
        download_gnis_zip(zip_path)
    except Exception as exc:  # noqa: BLE001 - report, then print manual steps
        print(f"\nDownload failed: {exc}", file=sys.stderr)
        print_manual_instructions(zip_path)
        sys.exit(1)
    return extract_txt_from_zip(zip_path, tmpdir)


def extract_txt_from_zip(zip_path: Path, tmpdir: Path) -> Path:
    print(f"Extracting {zip_path.name} …")
    with zipfile.ZipFile(zip_path) as z:
        txt_names = [n for n in z.namelist() if n.lower().endswith(".txt")]
        if not txt_names:
            raise ValueError(f"no .txt file found inside {zip_path}")
        # Prefer the national file if several are present.
        txt_names.sort(key=lambda n: ("national" not in n.lower(), n))
        chosen = txt_names[0]
        print(f"  using {chosen}")
        out = tmpdir / Path(chosen).name
        with z.open(chosen) as src, open(out, "wb") as dst:
            dst.write(src.read())
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build data/lakes/*.json from the USGS GNIS national names file."
    )
    ap.add_argument("--input",
                    help="Path to a previously downloaded GNIS national .txt (or .zip). "
                         "Skips the automatic download.")
    ap.add_argument("--out", default="data/lakes",
                    help="Output directory for per-state JSON files (default: data/lakes). "
                         "Relative to the repository root.")
    ap.add_argument("--max-per-state", type=int, default=None,
                    help="Cap the number of lakes written per state (default: no cap).")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    out_dir = (repo_root / args.out).resolve()

    with tempfile.TemporaryDirectory(prefix="gnis-") as tmp:
        tmpdir = Path(tmp)
        try:
            txt_path = resolve_input(args.input, tmpdir)
        except (FileNotFoundError, ValueError) as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1
        print("Parsing lake/reservoir features …")
        by_state = parse_lakes(txt_path, args.max_per_state)

    if not by_state:
        print("No lakes found — nothing written.", file=sys.stderr)
        return 1

    print(f"Writing per-state files to {out_dir} …")
    write_output(by_state, out_dir)
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
