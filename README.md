# Lake Weather Dashboard

A static web app (no build step — plain HTML, CSS, and vanilla JS) that shows
**historical weather for lakes across the United States**.

**Live demo:** https://gundersona.github.io/lake-weather-dashboard/

## Features

- **Lake picker** — choose a state, then search lakes by name with autocomplete
  (sample data ships for WI, CA, MI, MN, NY, FL; the full US set can be built
  from USGS GNIS — see below).
- **Interactive map** (Leaflet + OpenStreetMap) marking the selected lake.
- **Weather provider selector** — Open-Meteo (free, no key) works out of the box;
  Meteostat is a pluggable option in the provider registry for a future backend.
- **Date range picker** with hourly / daily / monthly aggregation.
- **Variables** — temperature, humidity, pressure, precipitation, wind speed,
  wind direction (toggle individually).
- **Visualizations** — summary stat cards, multi-axis line chart (Chart.js),
  bar chart (precipitation totals or mean temperature), an 8-bin wind rose,
  and a paginated data table.

## Run locally

Any static file server works (needed so `fetch()` can load the JSON data files):

```bash
cd lake-weather-dashboard
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy to GitHub Pages

1. Create a repo named `lake-weather-dashboard` and push this directory to the
   `main` branch.
2. In the repo: **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**.
3. The site will be served at `https://<your-username>.github.io/lake-weather-dashboard/`.

## Build the full US lake dataset

The app ships with sample lakes for six states. To generate per-state files
for the whole country from the USGS Geographic Names Information System (GNIS):

```bash
python3 scripts/build_lakes.py
```

This downloads the GNIS "DomesticNames National" text file, keeps
`Lake`/`Reservoir` features, and writes `data/lakes/<st>.json` plus a fresh
`data/lakes/index.json`. Run `python3 scripts/build_lakes.py --help` for
options (offline input file, per-state cap, custom output dir). If the
automatic download fails, the script prints manual download steps pointing to
https://www.usgs.gov/us-board-on-geographic-names/download-gnis-data.

## Provider notes

- **Open-Meteo** — free, no API key. Archive API serves ERA5 reanalysis data
  interpolated (bilinear) to the lake's GPS coordinates. Archive coverage:
  1940-01-01 to ~5 days ago, max 366 days per request (enforced in-app).
- **Meteostat** — listed as a selectable provider, but its API requires a
  server-side API key, so it is not available in this purely static build.
  The provider registry in `js/providers.js` is designed so adding it later
  is a single function.

## Project layout

```
index.html            # layout: controls sidebar + visualization cards
css/styles.css        # responsive card layout
js/
  config.js           # US states + weather variable definitions
  providers.js        # weather provider adapters (Open-Meteo, Meteostat stub)
  lakes.js            # lake catalogue loading + search
  app.js              # map, aggregation, charts, table, wind rose
data/lakes/           # index.json + per-state lake files
scripts/
  build_lakes.py      # GNIS → per-state lake JSON pipeline
```
