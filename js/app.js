// Lake Weather Dashboard — main application wiring.
"use strict";

/* global L, Chart, STATES, VARIABLES, PROVIDERS, fetchWeather, getSelectedLake */

const ROWS_PER_PAGE = 25;
const COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                   "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** NHD lake areas are stored as km^2; the UI filters in acres. */
const KM2_TO_ACRES = 247.105;
/** Variable keys with no Open-Meteo daily equivalent (hourly aggregation only). */
const HOURLY_ONLY_KEYS = ["relative_humidity_2m", "surface_pressure"];

let map = null;
/** Marker-cluster group holding one dot per lake of the chosen state. */
let lakeCluster = null;
/** lake object -> L.marker, for the currently shown state. */
const lakeMarkerByObj = new Map();
/** Currently highlighted (selected) lake marker, if any. */
let selectedDot = null;
let lineChart = null;
let compareCharts = [];
let tableRows = [];
/** Header rows for the data table: [[{ text, colspan?, rowspan? }, ...], ...]. */
let tableHeaderRows = [];
/** Footnote explaining max/min for the current aggregation; "" when none. */
let tableFooter = "";
let tablePage = 0;
/** { filename, headers, rows } for the Download CSV button; null when no table built. */
let csvData = null;

const $ = (id) => document.getElementById(id);

/**
 * Narrow portrait phones get a square-ish time series chart (aspectRatio 1)
 * instead of the cramped default 2:1; wider screens keep 2:1.
 */
const narrowChartQuery = window.matchMedia("(max-width: 600px)");
function chartAspectRatio() { return narrowChartQuery.matches ? 1 : 2; }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmt(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return Number(v).toFixed(digits);
}

function compass16(deg) {
  return COMPASS16[Math.round(deg / 22.5) % 16];
}

/** Circular mean of compass degrees (0–360). Returns degrees or null. */
function circularMean(degrees) {
  let sx = 0, sy = 0, n = 0;
  for (const d of degrees) {
    if (d === null || d === undefined || Number.isNaN(d)) continue;
    const r = (d * Math.PI) / 180;
    sx += Math.cos(r); sy += Math.sin(r); n++;
  }
  if (n === 0) return null;
  let deg = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

function mean(a) {
  const v = a.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  if (!v.length) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}
function min(a) {
  const v = a.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? Math.min(...v) : null;
}
function max(a) {
  const v = a.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? Math.max(...v) : null;
}
function sum(a) {
  const v = a.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.reduce((s, x) => s + x, 0);
}

/** Primary display stat per variable key. */
function primaryStat(key, stats) {
  if (key === "precipitation") return stats.total;
  if (key === "wind_direction_10m") return stats.prevailing;
  return stats.mean;
}

/** Short label for the stat plotted/reported per variable: avg, total, or prevailing. */
function statDescriptor(varDef) {
  if (varDef.key === "precipitation") return "total";
  if (varDef.key === "wind_direction_10m") return "prevailing";
  return "avg";
}

// ---------------------------------------------------------------- init

document.addEventListener("DOMContentLoaded", init);

function init() {
  setDefaultDates();
  initMap();
  window.__onLakeSelected = onLakeSelected;
  window.__onLakesLoaded = showLakesOnMap;
  $("load-btn").addEventListener("click", onLoad);
  $("prev-page").addEventListener("click", () => changePage(-1));
  $("next-page").addEventListener("click", () => changePage(1));
  $("download-csv").addEventListener("click", downloadCSV);
  $("provider").addEventListener("change", maybeProviderNotice);
  $("aggregation").addEventListener("change", () => {
    maybeProviderNotice();
    refreshDaylightRow();
  });
  refreshDaylightRow();
  $("zoom-lake-btn").addEventListener("click", () => {
    const lake = getSelectedLake();
    if (lake) highlightLake(lake, { zoom: true });
  });
  $("months-all").addEventListener("click", () => setAllMonths(true));
  $("months-none").addEventListener("click", () => setAllMonths(false));
  // Re-tall the time series chart if the phone rotates between portrait/landscape.
  if (typeof narrowChartQuery.addEventListener === "function") {
    narrowChartQuery.addEventListener("change", () => {
      if (lineChart) { lineChart.options.aspectRatio = chartAspectRatio(); lineChart.resize(); }
    });
  }
}

function setDefaultDates() {
  const d = (daysAgo) => {
    const t = new Date();
    t.setDate(t.getDate() - daysAgo);
    const mm = String(t.getMonth() + 1).padStart(2, "0");
    const dd = String(t.getDate()).padStart(2, "0");
    return `${t.getFullYear()}-${mm}-${dd}`;
  };
  $("end-date").value = d(5); // "To" defaults to 5 days ago: the archive lags ~5 days
  $("start-date").value = d(40);
}

/** State code -> boundary polygon layer, for highlighting the selected state. */
const stateLayerByCode = new Map();

function defaultStateStyle() {
  return { color: "#94a3b8", weight: 1, opacity: 0.7, fillColor: "#94a3b8", fillOpacity: 0.05 };
}

/** Highlight the selected state's boundary on the map ("" = none selected). */
function highlightState(code) {
  for (const [c, layer] of stateLayerByCode) {
    layer.setStyle(c === code
      ? { color: "#2563eb", weight: 2, opacity: 0.9, fillColor: "#2563eb", fillOpacity: 0.08 }
      : defaultStateStyle());
  }
}

/** Select a state programmatically — e.g. from a click on the map. */
function selectState(code) {
  if (!code || code === currentStateCode) return;
  const st = STATES.find((s) => s.code === code);
  if (!st) return;
  stateInput.value = st.name;
  onStateChange(code);
}

function initMap() {
  if (typeof L === "undefined") {
    $("map").innerHTML = '<p class="empty-note">Map library failed to load.</p>';
    return;
  }
  map = L.map("map", { tapTolerance: COARSE_POINTER ? 30 : 15 }).setView([39.8, -98.5], 4);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // Clickable state boundaries as an alternative to the state dropdown.
  fetch("data/us-states.geojson")
    .then((resp) => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    })
    .then((geo) => {
      const nameToCode = new Map(STATES.map((st) => [st.name, st.code]));
      L.geoJSON(geo, {
        style: defaultStateStyle,
        onEachFeature: (feature, layer) => {
          const name = feature.properties && feature.properties.name;
          const code = nameToCode.get(name) || null;
          if (code) stateLayerByCode.set(code, layer);
          if (name) layer.bindTooltip(name, { sticky: true });
          if (code) layer.on("click", () => selectState(code));
        },
      }).addTo(map);
      highlightState(currentStateCode);
    })
    .catch((err) => console.error("state boundaries failed to load:", err));
}

/** Touch devices get bigger lake dots and a more forgiving tap radius. */
const COARSE_POINTER = typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;
const LAKE_DOT = COARSE_POINTER ? 20 : 10;
const LAKE_DOT_SEL = COARSE_POINTER ? 26 : 14;

const lakeDotIcon = () =>
  L.divIcon({ className: "lake-dot", iconSize: [LAKE_DOT, LAKE_DOT], iconAnchor: [LAKE_DOT / 2, LAKE_DOT / 2] });
const lakeDotSelectedIcon = () =>
  L.divIcon({ className: "lake-dot selected", iconSize: [LAKE_DOT_SEL, LAKE_DOT_SEL], iconAnchor: [LAKE_DOT_SEL / 2, LAKE_DOT_SEL / 2] });

/**
 * Show every lake of the chosen state as a clickable dot (clustered).
 * Called from lakes.js after a state's lake file loads; [] clears the map.
 */
function showLakesOnMap(lakes) {
  if (!map || typeof L === "undefined") return;
  if (lakeCluster) { map.removeLayer(lakeCluster); lakeCluster = null; }
  lakeMarkerByObj.clear();
  selectedDot = null;

  const noteEl = document.getElementById("map-note");
  if (!lakes || lakes.length === 0) {
    if (noteEl) noteEl.textContent = "Pick a state — or click a state on the map — to see its lakes.";
    return;
  }
  if (typeof L.markerClusterGroup === "undefined") {
    if (noteEl) noteEl.textContent = "Lake markers unavailable — marker library failed to load.";
    return;
  }

  lakeCluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 60,
    disableClusteringAtZoom: 12,
  });
  for (const lake of lakes) {
    const m = L.marker([lake.lat, lake.lon], { icon: lakeDotIcon(), title: lake.name });
    m.on("click", () => {
      // lakes.js exposes selectLake globally; skip the zoom (already looking at it).
      if (typeof selectLake === "function") selectLake(lake, { zoom: false });
    });
    lakeMarkerByObj.set(lake, m);
    lakeCluster.addLayer(m);
  }
  map.addLayer(lakeCluster);
  map.fitBounds(lakeCluster.getBounds().pad(0.05));
  if (noteEl) {
    noteEl.textContent = `${lakes.length.toLocaleString()} lakes — click a dot to select, or click another state on the map to switch.`;
  }
}

/** Highlight the selected lake's dot and pop it up; zoom only when asked. */
function highlightLake(lake, { zoom } = {}) {
  if (!map) return;
  if (selectedDot) { selectedDot.setIcon(lakeDotIcon()); selectedDot = null; }
  const m = lakeMarkerByObj.get(lake);
  if (!m) return;
  selectedDot = m;
  m.setIcon(lakeDotSelectedIcon());
  m.bindPopup(
    `<b>${esc(lake.name)}</b><br>${esc(lake.county || "unknown county")}, ${esc(lake.state)}` +
    `<br>${lake.lat.toFixed(3)}, ${lake.lon.toFixed(3)}`
  );
  if (zoom && lakeCluster) {
    // Drill through clusters so the popup is actually visible.
    lakeCluster.zoomToShowLayer(m, () => m.openPopup());
  } else {
    m.openPopup();
  }
}

function onLakeSelected(lake, opts) {
  highlightLake(lake, { zoom: !opts || opts.zoom !== false });
}

function maybeProviderNotice() {
  const provider = $("provider").value;
  // Keep the aggregation hint accurate: in compare mode Meteostat serves
  // daily humidity/pressure, so they don't need hourly.
  const aggNote = document.querySelector('#aggregation + .empty-note');
  if (provider === "meteostat") {
    setStatus(
      "Meteostat interpolates the nearest weather stations (within 50 km). " +
      "First use loads a 450 KB station directory. Monthly mode skips wind " +
      "direction (not reported monthly).",
      false);
  } else if (provider === "both") {
    setStatus(
      "Compare mode loads both providers. Gaps are shown as —: monthly wind " +
      "direction is Open-Meteo only, daily humidity and pressure are Meteostat only, " +
      "and each provider covers dates up to its own freshness limit.",
      false);
  } else {
    setStatus("");
  }
  if (aggNote) {
    aggNote.textContent = provider === "both"
      ? "Humidity & pressure: hourly for Open-Meteo, daily OK via Meteostat. Monthly goes back 50 years."
      : "Humidity & pressure need hourly. Monthly goes back 50 years.";
  }
}

// ---------------------------------------------------------------- shared filters
// The month / temperature / area filters live in Controls and apply to both
// weather loading and lake analysis.

/** Months (1–12) currently selected in the Months filter. */
function getActiveMonths() {
  return [...document.querySelectorAll('#month-filter input[data-month]:checked')]
    .map((c) => parseInt(c.getAttribute("data-month"), 10));
}

function setAllMonths(on) {
  document.querySelectorAll('#month-filter input[data-month]')
    .forEach((c) => { c.checked = on; });
}

function getRange(minId, maxId) {
  const min = parseFloat($(minId).value);
  const max = parseFloat($(maxId).value);
  return { min: Number.isNaN(min) ? null : min, max: Number.isNaN(max) ? null : max };
}

/** Temperature filter in °F; null bound = no bound. */
function getTempRange() { return getRange("filter-temp-min", "filter-temp-max"); }

/** Area filter in acres; null bound = no bound. */
function getAreaRange() { return getRange("filter-area-min", "filter-area-max"); }

function acresOf(lake) {
  return lake.area_km2 == null ? null : lake.area_km2 * KM2_TO_ACRES;
}

/**
 * Does a lake pass the shared area filter? A lake with no NHD area data can't
 * be verified against the filter, so it's excluded when the filter is active.
 */
function lakePassesAreaFilter(lake) {
  const { min, max } = getAreaRange();
  if (min === null && max === null) return true;
  const ac = acresOf(lake);
  if (ac === null) return false;
  return (min === null || ac >= min) && (max === null || ac <= max);
}

function formatAcres(km2) {
  if (km2 == null) return "—";
  const ac = km2 * KM2_TO_ACRES;
  if (ac < 1) return "<1";
  if (ac < 10) return ac.toFixed(1);
  return Math.round(ac).toLocaleString("en-US");
}

/** Show the 24hr/daylight toggle only when hourly aggregation is selected. */
function refreshDaylightRow() {
  const hourly = $("aggregation").value === "hourly";
  $("daylight-row").hidden = !hourly;
  $("daylight-note").hidden = !hourly;
}

/** True when the daylight toggle is on (only meaningful for hourly mode). */
function daylightOnly() {
  return $("aggregation").value === "hourly" && $("daylight-toggle").checked;
}

/**
 * Drop nighttime hours from one provider's dataset when the daylight toggle
 * is on, using sunrise/sunset computed from the lake's lat/lon. Runs before
 * the shared filters so daily means, summaries, charts, the wind rose, the
 * table, and the CSV all see daylight hours only.
 */
function applyDaylight(data, lake) {
  if (!daylightOnly()) return data;
  return filterDaylight(data, lake.lat, lake.lon, data.utcOffsetSeconds ?? null);
}

/** Human-readable summary of the active shared filters, for status lines. */
function describeActiveFilters() {
  const parts = [];
  if (daylightOnly()) parts.push("daylight hours only");
  const months = getActiveMonths();
  if (months.length < 12) parts.push("months: " + months.map((m) => MONTH_ABBR[m - 1]).join(", "));
  const t = getTempRange();
  if (t.min !== null || t.max !== null) parts.push(`temp ${t.min ?? "…"}–${t.max ?? "…"}°F`);
  const a = getAreaRange();
  if (a.min !== null || a.max !== null) parts.push(`area ${a.min ?? "…"}–${a.max ?? "…"} acres`);
  return parts.length ? " Filters: " + parts.join("; ") + "." : "";
}

/**
 * Per-day info for month/temperature filtering: Map of "YYYY-MM-DD" ->
 * { month, meanTemp }. In hourly mode the daily mean is derived from the 24
 * hourly temperature values; otherwise it comes straight from the API.
 */
function computeDayInfo(data, needTemp) {
  const days = new Map();
  data.time.forEach((t, i) => {
    const dk = t.slice(0, 10);
    let d = days.get(dk);
    if (!d) {
      d = { month: parseInt(dk.slice(5, 7), 10), temps: [] };
      days.set(dk, d);
    }
    if (needTemp) {
      const v = (data.values["temperature_2m"] || [])[i];
      if (v !== null && v !== undefined && !Number.isNaN(v)) d.temps.push(v);
    }
  });
  const out = new Map();
  for (const [dk, d] of days) {
    out.set(dk, {
      month: d.month,
      meanTemp: d.temps.length ? d.temps.reduce((s, x) => s + x, 0) / d.temps.length : null,
    });
  }
  return out;
}

/** Copy of the dataset containing only the given "YYYY-MM-DD" day keys. */
function filterDataToDays(data, keepDays) {
  const idx = [];
  data.time.forEach((t, i) => { if (keepDays.has(t.slice(0, 10))) idx.push(i); });
  const values = {};
  for (const k of Object.keys(data.values)) values[k] = idx.map((i) => data.values[k][i]);
  return { time: idx.map((i) => data.time[i]), values, resolution: data.resolution };
}

/**
 * Apply the shared month + temperature filters to one provider's dataset:
 * keep whole days whose month is selected and whose daily mean temperature is
 * in range (hourly mode derives the daily mean from the hourly values —
 * daylight hours only when the daylight toggle is on).
 * Returns the filtered dataset, or null when no days match.
 */
function applySharedFilters(data, months, tempRange, tempActive) {
  const dayInfo = computeDayInfo(data, tempActive);
  const keepDays = new Set();
  for (const [dk, info] of dayInfo) {
    if (!months.includes(info.month)) continue;
    if (tempActive) {
      const t = info.meanTemp;
      if (t === null || t === undefined) continue;
      if (tempRange.min !== null && t < tempRange.min) continue;
      if (tempRange.max !== null && t > tempRange.max) continue;
    }
    keepDays.add(dk);
  }
  if (!keepDays.size) return null;
  return filterDataToDays(data, keepDays);
}

// ---------------------------------------------------------------- load

function selectedVariables() {
  const checked = [...document.querySelectorAll('input[type="checkbox"][data-var]:checked')]
    .map((c) => c.getAttribute("data-var"));
  return VARIABLES.filter((v) => checked.includes(v.key));
}

async function onLoad() {
  const lake = getSelectedLake();
  if (!lake) { setStatus("Please select a lake first (choose a state, then search).", true); return; }

  const start = $("start-date").value;
  const end = $("end-date").value;
  if (!start || !end) { setStatus("Please choose both a From and a To date.", true); return; }

  let vars = selectedVariables();
  if (vars.length === 0) { setStatus("Please select at least one variable.", true); return; }

  const months = getActiveMonths();
  if (!months.length) { setStatus("Select at least one month in the Months filter.", true); return; }

  if (!lakePassesAreaFilter(lake)) {
    const ac = acresOf(lake);
    const r = getAreaRange();
    setStatus(
      `${lake.name} is ${ac === null ? "missing area data" : "about " + formatAcres(lake.area_km2) + " acres"}` +
      ` — outside the area filter (${r.min ?? "any"}–${r.max ?? "any"} acres).`,
      true);
    return;
  }

  const provider = $("provider").value;
  const aggregation = $("aggregation").value;
  const isCompare = provider === "both";

  // Variables a single provider can't serve at this aggregation are skipped
  // with a note: Open-Meteo has no daily humidity/pressure; Meteostat has no
  // monthly wind direction. In compare mode nothing is dropped — each provider
  // fetches what it can and gaps render as "—".
  let skipped = [];
  if (!isCompare) {
    if (provider === "open-meteo" && aggregation !== "hourly") {
      skipped = vars.filter((v) => HOURLY_ONLY_KEYS.includes(v.key));
      vars = vars.filter((v) => !HOURLY_ONLY_KEYS.includes(v.key));
    } else if (provider === "meteostat" && aggregation === "monthly") {
      skipped = vars.filter((v) => v.key === "wind_direction_10m");
      vars = vars.filter((v) => v.key !== "wind_direction_10m");
    }
    if (vars.length === 0) {
      const why = provider === "open-meteo"
        ? "humidity and pressure need hourly mode"
        : "Meteostat doesn't report wind direction by month";
      setStatus("None of the selected variables are available for " + aggregation +
        " aggregation — " + why + ".", true);
      return;
    }
  }
  const params = vars.map((v) => v.param);

  // The temperature filter needs temperature data even when it's unchecked —
  // fetch it silently and keep it out of the displayed variables.
  const tempRange = getTempRange();
  const tempActive = tempRange.min !== null || tempRange.max !== null;
  const fetchParams = [...params];
  if (tempActive && !fetchParams.includes("temperature_2m")) fetchParams.push("temperature_2m");

  // Compare mode: per-provider fetch params, dropping what each provider
  // can't serve so its request doesn't throw.
  const omParams = isCompare && aggregation !== "hourly"
    ? fetchParams.filter((p) => !HOURLY_ONLY_KEYS.includes(p))
    : fetchParams;
  const msParams = isCompare && aggregation === "monthly"
    ? fetchParams.filter((p) => p !== "wind_direction_10m")
    : fetchParams;

  const btn = $("load-btn");
  btn.disabled = true;
  btn.textContent = "Loading…";
  const providerName = isCompare ? "both providers"
    : provider === "open-meteo" ? "Open-Meteo" : "Meteostat";
  setStatus(`Fetching ${providerName} data for ${lake.name}…`);
  const loadProviders = isCompare
    ? ["open-meteo", "meteostat"].filter((p) => (p === "open-meteo" ? omParams.length : msParams.length))
    : [provider];
  showLoadProgress(loadProviders);

  try {
    if (isCompare) {
      await loadCompare({ lake, start, end, vars, months, tempRange, tempActive, aggregation, omParams, msParams });
    } else {
      setProviderProgress(provider, null, null, "Fetching…");
      let data = await fetchWeather(provider, lake.lat, lake.lon, start, end, fetchParams, aggregation,
        provider === "meteostat"
          ? { onProgress: (done, total) => setProviderProgress("meteostat", done, total, `Station data ${done}/${total}`) }
          : undefined);
      setProviderDone(provider);
      if (!data.time.length) throw new Error("No data returned for this date range.");
      data = applyDaylight(data, lake);
      if (!data.time.length) {
        throw new Error("No daylight hours in the selected range — the sun never rises there on these dates.");
      }

      const fdata = applySharedFilters(data, months, tempRange, tempActive);
      if (!fdata) throw new Error("No days in the selected range match the month/temperature filters.");

      const buckets = aggregate(fdata, vars, aggregation);
      renderStatCards(fdata, vars);
      showChartMode("single");
      renderLineChart(buckets, vars, aggregation);
      buildTable(buckets, vars, { lake, start, end, aggregation });
      renderWindRose(fdata, provider);
      if (provider === "meteostat") renderStationTable(data.stations, lake);
      else $("station-card").hidden = true;

      $("visuals").hidden = false;

      let msg = `Loaded ${buckets.length} ${aggregation} period${buckets.length === 1 ? "" : "s"} for ${lake.name} (${start} to ${end}).` +
        describeActiveFilters();
      if (skipped.length) {
        const reason = provider === "meteostat" ? "(not reported by month)" : "(hourly aggregation only)";
        msg += ` Skipped ${skipped.map((v) => v.label).join(", ")} ${reason}.`;
      }
      setStatus(msg);
    }
  } catch (err) {
    if (!isCompare) setProviderError(provider, err.message || "load failed");
    setStatus(err.message || "Something went wrong while loading weather data.", true);
    console.error(err);
  } finally {
    hideLoadProgress();
    btn.disabled = false;
    btn.textContent = "Load weather";
  }
}

/**
 * Compare mode: fetch both providers (each clamped to the latest date it can
 * serve), then render the comparison views.
 */
async function loadCompare(opts) {
  const { lake, start, end, vars, months, tempRange, tempActive, aggregation, omParams, msParams } = opts;

  const omMaxEnd = maxEndDate("open-meteo", aggregation);
  const msMaxEnd = maxEndDate("meteostat", aggregation);
  const omEnd = end > omMaxEnd ? omMaxEnd : end;
  const msEnd = end > msMaxEnd ? msMaxEnd : end;

  const [omRaw, msRaw, omErr, msErr] = await (async () => {
    // Each provider is fetched independently: if one fails (e.g. Open-Meteo
    // hourly outside its 30-year window), the other still renders and the
    // failure is reported in the status line.
    let omR = null, msR = null, omE = null, msE = null;
    const jobs = [];
    if (omParams.length) {
      setProviderProgress("open-meteo", null, null, "Fetching…");
      jobs.push(fetchWeather("open-meteo", lake.lat, lake.lon, start, omEnd, omParams, aggregation,
        aggregation === "hourly" ? { timezone: "UTC" } : {})
        .then((d) => { omR = d; setProviderDone("open-meteo"); })
        .catch((e) => { omE = e; setProviderError("open-meteo", e.message); }));
    }
    if (msParams.length) {
      setProviderProgress("meteostat", null, null, "Starting…");
      jobs.push(fetchWeather("meteostat", lake.lat, lake.lon, start, msEnd, msParams, aggregation, {
        onProgress: (done, total) => setProviderProgress("meteostat", done, total, `Station data ${done}/${total}`),
      })
        .then((d) => { msR = d; setProviderDone("meteostat"); })
        .catch((e) => { msE = e; setProviderError("meteostat", e.message); }));
    }
    await Promise.all(jobs);
    return [omR, msR, omE, msE];
  })();
  if ((!omRaw || !omRaw.time.length) && (!msRaw || !msRaw.time.length)) {
    throw new Error((omErr && omErr.message) || (msErr && msErr.message) ||
      "No data returned for this date range.");
  }

  // Hourly timestamps are canonicalized so the two UTC series share bucket keys,
  // then daylight filtering drops nighttime hours when the toggle is on.
  let omData = omRaw && omRaw.time.length ? canonicalizeTimes(omRaw, aggregation) : null;
  let msData = msRaw && msRaw.time.length ? canonicalizeTimes(msRaw, aggregation) : null;
  if (daylightOnly()) {
    if (omData) omData = applyDaylight(omData, lake);
    if (msData) msData = applyDaylight(msData, lake);
    if ((!omData || !omData.time.length) && (!msData || !msData.time.length)) {
      throw new Error("No daylight hours in the selected range — the sun never rises there on these dates.");
    }
  }

  const omFiltered = omData ? applySharedFilters(omData, months, tempRange, tempActive) : null;
  const msFiltered = msData ? applySharedFilters(msData, months, tempRange, tempActive) : null;
  if (!omFiltered && !msFiltered) {
    throw new Error("No days in the selected range match the month/temperature filters.");
  }

  const omBuckets = omFiltered ? aggregate(omFiltered, vars, aggregation) : [];
  const msBuckets = msFiltered ? aggregate(msFiltered, vars, aggregation) : [];
  const merged = mergeBuckets(omBuckets, msBuckets);

  renderCompareSummary(omFiltered, msFiltered, vars);
  showChartMode("compare");
  renderCompareCharts(merged, vars, aggregation);
  buildCompareTable(merged, vars, { lake, start, end, aggregation });
  renderWindRoseCompare(omFiltered, msFiltered, vars);
  renderStationTable(msRaw && msRaw.stations, lake);

  $("visuals").hidden = false;

  let msg = `Loaded ${merged.length} ${aggregation} period${merged.length === 1 ? "" : "s"} for ${lake.name} (${start} to ${end}): ` +
    `Open-Meteo ${omBuckets.length}, Meteostat ${msBuckets.length} periods.` +
    describeActiveFilters();
  if (omEnd < end) msg += ` Open-Meteo data ends ${omEnd}.`;
  if (msEnd < end) msg += ` Meteostat data ends ${msEnd}.`;
  if (omErr) msg += ` Open-Meteo failed: ${omErr.message}`;
  if (msErr) msg += ` Meteostat failed: ${msErr.message}`;
  // Name the known per-provider gaps so "—" cells aren't a mystery.
  const gaps = [];
  if (aggregation !== "hourly" && vars.some((v) => HOURLY_ONLY_KEYS.includes(v.key))) {
    gaps.push("humidity/pressure is Meteostat only");
  }
  if (aggregation === "monthly" && vars.some((v) => v.key === "wind_direction_10m")) {
    gaps.push("monthly wind direction is Open-Meteo only");
  }
  if (gaps.length) msg += ` Gaps shown as — (${gaps.join("; ")}).`;
  setStatus(msg);
}

/** Hourly: trim timestamps to "YYYY-MM-DDTHH:MM" so both UTC series align. */
function canonicalizeTimes(data, aggregation) {
  if (aggregation !== "hourly") return data;
  return { ...data, time: data.time.map((t) => t.slice(0, 16)) };
}

/**
 * Union of two providers' bucket lists by label; each entry carries
 * { label, om: stats|null, ms: stats|null }.
 */
function mergeBuckets(omBuckets, msBuckets) {
  const map = new Map();
  for (const b of omBuckets) map.set(b.label, { label: b.label, om: b.stats, ms: null });
  for (const b of msBuckets) {
    const e = map.get(b.label);
    if (e) e.ms = b.stats;
    else map.set(b.label, { label: b.label, om: null, ms: null });
  }
  return [...map.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** Show one progress row per provider being fetched. */
function showLoadProgress(providers) {
  const wrap = $("load-progress");
  for (const row of wrap.querySelectorAll(".provider-progress")) {
    const active = providers.includes(row.dataset.provider);
    row.hidden = !active;
    if (active) setProviderProgress(row.dataset.provider, null, null, "Starting…");
  }
  wrap.hidden = false;
}

/**
 * Update a provider's progress row. done/total = null renders an
 * indeterminate bar (Open-Meteo is a single request — nothing to count).
 */
function setProviderProgress(provider, done, total, stateText) {
  const row = document.querySelector(`.provider-progress[data-provider="${provider}"]`);
  if (!row || row.hidden) return;
  const bar = row.querySelector("progress");
  if (done === null || total === null || total === 0) bar.removeAttribute("value");
  else bar.value = Math.round((done / total) * 100);
  row.querySelector(".pp-state").textContent = stateText;
  row.classList.remove("error");
}

function setProviderDone(provider) {
  const row = document.querySelector(`.provider-progress[data-provider="${provider}"]`);
  if (!row || row.hidden) return;
  row.querySelector("progress").value = 100;
  row.querySelector(".pp-state").textContent = "Done";
  row.classList.remove("error");
}

function setProviderError(provider, msg) {
  const row = document.querySelector(`.provider-progress[data-provider="${provider}"]`);
  if (!row || row.hidden) return;
  row.querySelector(".pp-state").textContent = `Failed: ${msg}`;
  row.classList.add("error");
}

function hideLoadProgress() { $("load-progress").hidden = true; }

function setStatus(msg, isError) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}

// ---------------------------------------------------------------- aggregation

function bucketKey(iso, mode) {
  if (mode === "daily") return iso.slice(0, 10);
  if (mode === "monthly") return iso.slice(0, 7);
  return iso; // hourly
}

/**
 * Backing series for a variable + stat. Daily-resolution data stores the true
 * daily aggregates separately, so min/max stats read those columns instead of
 * the mean series.
 */
function seriesFor(data, varDef, stat) {
  if (data.resolution === "daily" && (stat === "min" || stat === "max")) {
    const extra = data.values[`${varDef.key}_${stat}`];
    if (Array.isArray(extra)) return extra;
  }
  return data.values[varDef.param] || [];
}

function computeStats(varDef, getValues) {
  const s = {};
  for (const stat of varDef.stats) {
    const values = getValues(stat);
    if (stat === "mean") s.mean = mean(values);
    else if (stat === "min") s.min = min(values);
    else if (stat === "max") s.max = max(values);
    else if (stat === "total") s.total = sum(values);
    else if (stat === "prevailing") s.prevailing = circularMean(values);
  }
  return s;
}

/** Group series into buckets; returns [{label, stats: {varKey: {...}}}]. */
function aggregate(data, vars, mode) {
  const groups = new Map();
  data.time.forEach((t, i) => {
    const key = bucketKey(t, mode);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });

  const keys = [...groups.keys()].sort();
  return keys.map((key) => {
    const idx = groups.get(key);
    const stats = {};
    for (const v of vars) {
      stats[v.key] = computeStats(v, (stat) => idx.map((i) => seriesFor(data, v, stat)[i]));
    }
    return { label: key, stats };
  });
}

/** Overall stats across the whole raw series (for the summary cards). */
function overallStats(data, varDef) {
  return computeStats(varDef, (stat) => seriesFor(data, varDef, stat));
}

// ---------------------------------------------------------------- stat cards

function renderStatCards(data, vars) {
  $("compare-wrap").hidden = true;
  $("stat-cards").hidden = false;
  const wrap = $("stat-cards");
  wrap.innerHTML = "";
  const n = data.time.length;

  for (const v of vars) {
    const s = overallStats(data, v);
    const card = document.createElement("div");
    card.className = "stat-card";
    card.style.borderLeftColor = v.color;

    let big, sub;
    if (v.key === "precipitation") {
      big = `${fmt(s.total)} ${v.unit}`;
      sub = `total over ${n} ${data.resolution === "daily" ? "days" : "hours"}`;
    } else if (v.key === "wind_direction_10m") {
      big = s.prevailing === null ? "—" : `${compass16(s.prevailing)} ${Math.round(s.prevailing)}°`;
      sub = "prevailing direction";
    } else {
      const hasMean = s.mean !== null && s.mean !== undefined;
      // Max-only variables (e.g. Peak gust) have no mean; lead with the max.
      big = hasMean ? `${fmt(s.mean)} ${v.unit}` : `${fmt(s.max)} ${v.unit}`;
      if (hasMean) {
        const parts = [];
        if (s.min !== null && s.min !== undefined) parts.push(`min ${fmt(s.min)}`);
        if (s.max !== null && s.max !== undefined) parts.push(`max ${fmt(s.max)}`);
        sub = parts.join(" · ") + (parts.length ? ` ${v.unit}` : "no data");
      } else {
        const periodWord = data.resolution === "daily" ? "days" : "hours";
        sub = s.max !== null && s.max !== undefined ? `max over ${n} ${periodWord}` : "no data";
      }
    }

    const label = document.createElement("div");
    label.className = "stat-label";
    label.textContent = v.label;
    const value = document.createElement("div");
    value.className = "stat-value";
    value.textContent = big;
    const subEl = document.createElement("div");
    subEl.className = "stat-sub";
    subEl.textContent = sub;
    card.append(label, value, subEl);
    wrap.appendChild(card);
  }
}

// ---------------------------------------------------------------- compare summary table

/** { main, sub } display strings for one provider's overall stats of a variable. */
function compareCellParts(stats, varDef) {
  if (!stats) return { main: "—", sub: "" };
  if (varDef.key === "precipitation") {
    return stats.total === null || stats.total === undefined
      ? { main: "—", sub: "" }
      : { main: `${fmt(stats.total)} ${varDef.unit}`, sub: "total" };
  }
  if (varDef.key === "wind_direction_10m") {
    return stats.prevailing === null || stats.prevailing === undefined
      ? { main: "—", sub: "" }
      : { main: `${compass16(stats.prevailing)} ${Math.round(stats.prevailing)}°`, sub: "prevailing" };
  }
  if (stats.mean === null || stats.mean === undefined) {
    // Max-only variables (e.g. Peak gust): show the max alone.
    if (stats.max !== null && stats.max !== undefined)
      return { main: `${fmt(stats.max)} ${varDef.unit}`, sub: "max" };
    return { main: "—", sub: "" };
  }
  const parts = [];
  if (stats.min !== null && stats.min !== undefined) parts.push(`min ${fmt(stats.min)}`);
  if (stats.max !== null && stats.max !== undefined) parts.push(`max ${fmt(stats.max)}`);
  return {
    main: `${fmt(stats.mean)} ${varDef.unit}`,
    sub: parts.length ? `${parts.join(" · ")} ${varDef.unit}` : "",
  };
}

/** Signed "Meteostat minus Open-Meteo" delta for one variable, or "—". */
function compareDelta(omStats, msStats, varDef) {
  if (!omStats || !msStats || varDef.key === "wind_direction_10m") return "—";
  // Max-only variables (e.g. Peak gust) compare their max.
  const pick = (s) => (varDef.key === "precipitation" ? s.total : s.mean ?? s.max);
  const a = pick(omStats), b = pick(msStats);
  if (a === null || a === undefined || b === null || b === undefined) return "—";
  const d = b - a;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  return `${sign}${fmt(Math.abs(d))} ${varDef.unit}`;
}

function renderCompareSummary(omData, msData, vars) {
  $("stat-cards").hidden = true;
  const wrap = $("compare-wrap");
  wrap.hidden = false;
  const table = $("compare-table");
  table.innerHTML = "";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const c of ["Variable", "Open-Meteo", "Meteostat", "Δ (MS − OM)"]) {
    const th = document.createElement("th");
    th.textContent = c;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const v of vars) {
    const omStats = omData ? overallStats(omData, v) : null;
    const msStats = msData ? overallStats(msData, v) : null;
    const om = compareCellParts(omStats, v);
    const ms = compareCellParts(msStats, v);
    const tr = document.createElement("tr");
    const tdVar = document.createElement("td");
    tdVar.textContent = `${v.label} (${v.unit})`;
    tr.appendChild(tdVar);
    for (const cell of [om, ms]) {
      const td = document.createElement("td");
      const main = document.createElement("div");
      main.className = "cmp-main";
      main.textContent = cell.main;
      td.appendChild(main);
      if (cell.sub) {
        const sub = document.createElement("div");
        sub.className = "cmp-sub";
        sub.textContent = cell.sub;
        td.appendChild(sub);
      }
      tr.appendChild(td);
    }
    const tdD = document.createElement("td");
    tdD.textContent = compareDelta(omStats, msStats, v);
    tr.appendChild(tdD);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

// ---------------------------------------------------------------- line chart

// 30 years of hourly data is ~263k points: stride-sample the chart series so
// Chart.js stays responsive. Tables, summaries, and CSV keep full resolution.
const CHART_MAX_POINTS = 4000;

/** Indices [0..n) strided down to at most maxPoints, always keeping the endpoints. Null if no sampling needed. */
function strideIndices(n, maxPoints) {
  if (n <= maxPoints) return null;
  const stride = Math.ceil(n / maxPoints);
  const idx = [];
  for (let i = 0; i < n; i += stride) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx;
}

function renderLineChart(buckets, vars, aggregation) {
  if (lineChart) { lineChart.destroy(); lineChart = null; }
  if (typeof Chart === "undefined") return;

  const stride = strideIndices(buckets.length, CHART_MAX_POINTS);
  const chartBuckets = stride ? stride.map((i) => buckets[i]) : buckets;
  const labels = chartBuckets.map((b) => b.label);
  const unitToAxis = new Map();
  const scales = {};
  let axisCount = 0;

  const axisLabel = (v) => `${v.label} (${statDescriptor(v)}, ${v.unit})`;
  for (const v of vars) {
    if (!unitToAxis.has(v.unit)) {
      const id = `y${axisCount++}`;
      unitToAxis.set(v.unit, id);
      scales[id] = {
        type: "linear",
        display: true,
        position: axisCount === 1 ? "left" : "right",
        title: { display: true, text: axisLabel(v) },
        grid: { drawOnChartArea: axisCount === 1 },
      };
    }
  }

  const datasets = vars.map((v) => ({
    label: axisLabel(v),
    data: chartBuckets.map((b) => primaryStat(v.key, b.stats[v.key])),
    borderColor: v.color,
    backgroundColor: v.color,
    yAxisID: unitToAxis.get(v.unit),
    tension: 0.15,
    pointRadius: 0,
    spanGaps: true,
  }));

  // Title names the aggregation so it's clear the plotted values are
  // period averages (precipitation is always a total, not an average).
  const modeNoun = aggregation === "hourly" ? "Hourly values"
    : aggregation === "daily" ? "Daily averages" : "Monthly averages";
  const notes = [];
  if (aggregation !== "hourly" && vars.some((v) => v.key === "precipitation")) {
    notes.push("precipitation: totals");
  }
  if (stride) notes.push(`chart sampled to every ${stride[1] - stride[0]}th point`);
  const titleText = notes.length ? `${modeNoun} (${notes.join("; ")})` : modeNoun;

  lineChart = new Chart($("line-chart"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      aspectRatio: chartAspectRatio(),
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top" },
        title: { display: true, text: titleText },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 14, maxRotation: 45 } },
        ...scales,
      },
    },
  });
}

/**
 * Compare-mode time series: one line chart per variable (Open-Meteo solid,
 * Meteostat dashed, same color). Variables with no data from either provider
 * (e.g. Meteostat monthly wind) are skipped; the gap shows as "—" in the
 * summary table.
 */
function destroyCompareCharts() {
  for (const c of compareCharts) c.destroy();
  compareCharts = [];
}

function renderCompareCharts(merged, vars, aggregation) {
  destroyCompareCharts();
  if (typeof Chart === "undefined") return;

  const wrap = $("compare-charts");
  wrap.innerHTML = "";
  const stride = strideIndices(merged.length, CHART_MAX_POINTS);
  const chartMerged = stride ? stride.map((i) => merged[i]) : merged;
  const labels = chartMerged.map((b) => b.label);
  const modeNoun = aggregation === "hourly" ? "Hourly values"
    : aggregation === "daily" ? "Daily averages" : "Monthly averages";

  const providers = [
    { key: "om", name: "Open-Meteo", dash: [] },
    { key: "ms", name: "Meteostat", dash: [6, 4] },
  ];

  for (const v of vars) {
    const datasets = [];
    for (const p of providers) {
      const vals = chartMerged.map((b) => {
        const stats = b[p.key] && b[p.key][v.key];
        return stats ? primaryStat(v.key, stats) : null;
      });
      if (vals.every((x) => x === null || x === undefined)) continue;
      datasets.push({
        label: p.name,
        data: vals,
        borderColor: v.color,
        backgroundColor: v.color,
        borderDash: p.dash,
        tension: 0.15,
        pointRadius: 0,
        spanGaps: true,
      });
    }
    if (!datasets.length) continue;

    const fig = document.createElement("figure");
    fig.className = "var-chart";
    const cap = document.createElement("figcaption");
    let capText = `${v.label} (${statDescriptor(v)}, ${v.unit}) — ${modeNoun} (solid: Open-Meteo; dashed: Meteostat)`;
    if (aggregation !== "hourly" && v.key === "precipitation") capText += "; totals";
    if (stride) capText += `; chart shows every ${stride[1] - stride[0]}th point`;
    cap.textContent = capText;
    const canvas = document.createElement("canvas");
    fig.appendChild(cap);
    fig.appendChild(canvas);
    wrap.appendChild(fig);

    compareCharts.push(new Chart(canvas, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        aspectRatio: chartAspectRatio(),
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "top" } },
        scales: {
          x: { ticks: { maxTicksLimit: 14, maxRotation: 45 } },
          y: {
            title: { display: true, text: `${v.label} (${statDescriptor(v)}, ${v.unit})` },
          },
        },
      },
    }));
  }
}

/** Which chart surface the Time series card shows: single canvas or compare set. */
function showChartMode(mode) {
  const single = $("line-chart");
  const compare = $("compare-charts");
  if (mode === "compare") {
    if (lineChart) { lineChart.destroy(); lineChart = null; }
    single.hidden = true;
    compare.hidden = false;
  } else {
    destroyCompareCharts();
    compare.hidden = true;
    single.hidden = false;
  }
}

// ---------------------------------------------------------------- data table

function formatCell(varDef, stats) {
  const s = stats[varDef.key];
  if (!s) return "—";
  if (varDef.key === "precipitation") return fmt(s.total);
  if (varDef.key === "wind_direction_10m") {
    return s.prevailing === null ? "—" : `${compass16(s.prevailing)} ${Math.round(s.prevailing)}°`;
  }
  const parts = [];
  if (s.mean !== undefined) parts.push(`avg ${fmt(s.mean)}`);
  if (s.min !== undefined) parts.push(`min ${fmt(s.min)}`);
  if (s.max !== undefined) parts.push(`max ${fmt(s.max)}`);
  return parts.join(" / ") || "—";
}

/**
 * Table column specs for the current variable selection + aggregation.
 * Wind is split into per-stat columns — hourly: avg + peak gust;
 * daily/monthly: avg + max + peak gust. Every other variable keeps one
 * column with its stats inline. Each spec: { varDef, stat, group } where
 * stat is null for the combined column.
 */
function tableColumnSpecs(vars, aggregation) {
  const specs = [];
  for (const v of vars) {
    if (v.key === "wind_speed_10m") {
      specs.push({ varDef: v, stat: "mean", group: `Wind speed (${v.unit}): avg` });
      if (aggregation !== "hourly") {
        specs.push({ varDef: v, stat: "max", group: `Wind speed (${v.unit}): max` });
      }
      continue;
    }
    if (v.key === "wind_gusts_10m") {
      specs.push({ varDef: v, stat: "max", group: `Peak gust (${v.unit})` });
      continue;
    }
    const headerStat = v.key === "precipitation" ? "total"
      : v.key === "wind_direction_10m" ? "prevailing" : "avg / min / max";
    specs.push({ varDef: v, stat: null, group: `${v.label} (${v.unit}): ${headerStat}` });
  }
  return specs;
}

/** Cell text for one column spec: a single stat, or all stats inline. */
function specCell(spec, stats) {
  if (spec.stat === null) return formatCell(spec.varDef, stats);
  const s = stats[spec.varDef.key];
  if (!s) return "—";
  const v = s[spec.stat];
  return v === undefined || v === null ? "—" : fmt(v);
}

/** Footnote explaining what max/min mean for the selected aggregation. */
function tableFooterText(aggregation) {
  if (aggregation === "hourly") {
    return "Hourly: each row is one hour. Avg/min/max are that hour's observed values; peak gust is the hour's highest gust.";
  }
  if (aggregation === "daily") {
    return "Daily: avg = 24-hour mean (includes nighttime); max = highest value within the day — for wind, the highest hourly mean; peak gust = the day's highest gust.";
  }
  return "Monthly: values aggregate the daily series — avg = mean of daily values, max/min = highest/lowest daily value in the month, precipitation total = sum; peak gust = the month's highest daily peak gust.";
}

function buildTable(buckets, vars, meta) {
  const specs = tableColumnSpecs(vars, meta.aggregation);
  tableHeaderRows = [[{ text: "Period" }, ...specs.map((s) => ({ text: s.group }))]];
  tableRows = buckets.map((b) => ({
    label: b.label,
    cells: specs.map((s) => specCell(s, b.stats)),
  }));
  tablePage = 0;
  tableFooter = tableFooterText(meta.aggregation);
  setCsvData(meta, ["Period", ...specs.map((s) => s.group)], tableRows.map((r) => [r.label, ...r.cells]));
  renderTable();
}

/**
 * Compare mode: the variable/stat group spans a column pair and the
 * provider names (Open-Meteo / Meteostat) sit in a second header row.
 */
function buildCompareTable(merged, vars, meta) {
  const specs = tableColumnSpecs(vars, meta.aggregation);
  tableHeaderRows = [
    [{ text: "Period", rowspan: 2 }, ...specs.map((s) => ({ text: s.group, colspan: 2 }))],
    specs.flatMap(() => [{ text: "Open-Meteo" }, { text: "Meteostat" }]),
  ];
  tableRows = merged.map((b) => ({
    label: b.label,
    cells: specs.flatMap((s) => [specCell(s, b.om || {}), specCell(s, b.ms || {})]),
  }));
  tablePage = 0;
  tableFooter = tableFooterText(meta.aggregation);
  setCsvData(meta,
    ["Period", ...specs.flatMap((s) => [`${s.group} (Open-Meteo)`, `${s.group} (Meteostat)`])],
    tableRows.map((r) => [r.label, ...r.cells]));
  renderTable();
}

function setCsvData(meta, headers, rows) {
  if (!meta) { csvData = null; return; }
  const slug = meta.lake.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "lake";
  csvData = {
    filename: `lake-weather-${slug}-${meta.aggregation}-${meta.start}-to-${meta.end}.csv`,
    headers,
    rows,
  };
}

/** Download the full results table (all pages) as CSV. Works for any provider. */
function downloadCSV() {
  if (!csvData || !csvData.rows.length) {
    setStatus("No table data to download yet — load weather first.", true);
    return;
  }
  const esc = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [csvData.headers, ...csvData.rows].map((row) => row.map(esc).join(","));
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = csvData.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function renderTable() {
  const table = $("data-table");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";
  $("data-table-note").hidden = true;

  for (const row of tableHeaderRows) {
    const tr = document.createElement("tr");
    for (const h of row) {
      const th = document.createElement("th");
      th.textContent = h.text;
      if (h.colspan > 1) th.colSpan = h.colspan;
      if (h.rowspan > 1) th.rowSpan = h.rowspan;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }

  let tfoot = table.querySelector("tfoot");
  if (!tfoot) {
    tfoot = document.createElement("tfoot");
    table.appendChild(tfoot);
  }
  tfoot.innerHTML = "";
  if (tableFooter) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = tableHeaderRows[0].reduce((n, h) => n + (h.colspan || 1), 0);
    td.className = "table-footnote";
    td.textContent = tableFooter;
    tr.appendChild(td);
    tfoot.appendChild(tr);
  }

  const pages = Math.max(1, Math.ceil(tableRows.length / ROWS_PER_PAGE));
  tablePage = Math.min(Math.max(0, tablePage), pages - 1);
  const slice = tableRows.slice(tablePage * ROWS_PER_PAGE, (tablePage + 1) * ROWS_PER_PAGE);

  for (const row of slice) {
    const tr = document.createElement("tr");
    const td0 = document.createElement("td");
    td0.textContent = row.label;
    tr.appendChild(td0);
    for (const c of row.cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  if (slice.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = tableHeaderRows[0].reduce((n, h) => n + (h.colspan || 1), 0);
    td.className = "empty-note";
    td.textContent = "No data.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  $("page-info").textContent =
    tableRows.length === 0 ? "No data" : `Page ${tablePage + 1} of ${pages} (${tableRows.length} periods)`;
  $("prev-page").disabled = tablePage <= 0;
  $("next-page").disabled = tablePage >= pages - 1;
}

function changePage(delta) {
  tablePage += delta;
  renderTable();
}

// ---------------------------------------------------------------- Meteostat station summary

/** Bearing in degrees (0–360) from (lat1, lon1) to (lat2, lon2). */
function bearingTo(lat1, lon1, lat2, lon2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const d = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(d) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(d);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Summary table of the Meteostat stations used for interpolation: station name,
 * distance from the lake, and compass direction from the lake (e.g. "8 mi NE").
 */
function renderStationTable(stations, lake) {
  const card = $("station-card");
  if (!stations || !stations.length) {
    card.hidden = true;
    return;
  }
  const thead = $("station-table").querySelector("thead");
  const tbody = $("station-table").querySelector("tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";

  const hr = document.createElement("tr");
  for (const h of ["Station", "Distance", "Direction"]) {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);

  const rows = [...stations].sort((a, b) => a.dist - b.dist);
  for (const s of rows) {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = s.name || s.id;
    const tdDist = document.createElement("td");
    tdDist.textContent = `${Math.round(s.dist / 1609.344)} mi`;
    const tdDir = document.createElement("td");
    tdDir.textContent = compass16(bearingTo(lake.lat, lake.lon, s.lat, s.lon));
    tr.append(tdName, tdDist, tdDir);
    tbody.appendChild(tr);
  }
  card.hidden = false;
}

// ---------------------------------------------------------------- wind rose

/**
 * Draw one wind rose into the given canvas. emptyMsg covers the no-data case
 * (null data, or the wind variables weren't fetched/selected).
 */
function drawWindRose(canvas, data, emptyMsg) {
  const windSpeedUnit = () =>
    (VARIABLES.find((v) => v.key === "wind_speed_10m") || {}).unit || "mph";
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const speeds = (data && data.values["wind_speed_10m"]) || [];
  const dirs = (data && data.values["wind_direction_10m"]) || [];
  if (!speeds.length || !dirs.length) {
    ctx.fillStyle = "#6b7c8d";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(emptyMsg, W / 2, H / 2);
    return;
  }

  const BINS = 8;
  const binSum = new Array(BINS).fill(0);
  const binCount = new Array(BINS).fill(0);
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i], s = speeds[i];
    if (d === null || d === undefined || s === null || s === undefined) continue;
    const b = Math.round(d / 45) % BINS;
    binSum[b] += s;
    binCount[b] += 1;
  }
  const binMean = binSum.map((t, i) => (binCount[i] ? t / binCount[i] : 0));
  const maxMean = Math.max(...binMean, 0.0001);

  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 46;
  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

  // Concentric reference circles.
  ctx.strokeStyle = "#dbe5ec";
  ctx.fillStyle = "#6b7c8d";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  for (const f of [1 / 3, 2 / 3, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
    ctx.stroke();
    const valLabel = `${(maxMean * f).toFixed(1)}`;
    ctx.fillText(valLabel, cx + 4, cy - R * f - 3);
    if (f === 1) {
      // Unit sits on the same baseline, just right of the outer ring value —
      // kept clear of the "N" compass label above it.
      const w = ctx.measureText(valLabel).width;
      ctx.fillText(windSpeedUnit(), cx + 4 + w / 2 + 12, cy - R * f - 3);
    }
  }

  // Wedges: bin i centered at angle -90° + i*45° (N at top).
  for (let i = 0; i < BINS; i++) {
    const r = (binMean[i] / maxMean) * R;
    if (r <= 0) continue;
    const center = (-90 + i * 45) * Math.PI / 180;
    const half = (22.5 * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, center - half, center + half);
    ctx.closePath();
    ctx.fillStyle = "rgba(26, 127, 191, 0.55)";
    ctx.fill();
    ctx.strokeStyle = "#1a7fbf";
    ctx.stroke();
  }

  // Direction labels.
  ctx.fillStyle = "#1f2d3d";
  ctx.font = "bold 12px sans-serif";
  for (let i = 0; i < BINS; i++) {
    const a = (-90 + i * 45) * Math.PI / 180;
    ctx.fillText(labels[i], cx + Math.cos(a) * (R + 20), cy + Math.sin(a) * (R + 20) + 4);
  }

  // Prevailing direction marker: red arrow at the circular mean of the
  // direction series (0° = N, same convention as the wedges).
  const prevailing = circularMean(dirs);
  if (prevailing !== null) {
    const a = ((-90 + (prevailing % 360)) * Math.PI) / 180;
    const tipX = cx + Math.cos(a) * (R + 10);
    const tipY = cy + Math.sin(a) * (R + 10);
    ctx.strokeStyle = "#e74c3c";
    ctx.fillStyle = "#e74c3c";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    const ahLen = 11, spread = Math.PI / 7;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ahLen * Math.cos(a - spread), tipY - ahLen * Math.sin(a - spread));
    ctx.lineTo(tipX - ahLen * Math.cos(a + spread), tipY - ahLen * Math.sin(a + spread));
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 1;
  }
}

/** Note text under the wind rose(s): what the wedges mean + data source. */
function windRoseNote(data, provider) {
  const res = data && data.resolution === "hourly"
    ? " Built from every hourly observation in the range."
    : " Built from one value per day (dominant direction and daily mean speed), " +
      "so expect a coarser picture than hourly mode.";
  const src = provider === "meteostat"
    ? " Meteostat interpolates nearby stations (within 50 km)."
    : "";
  return "Each wedge points in the compass direction the wind <em>comes from</em>; " +
    "its length is the average wind speed from that direction over the selected period. " +
    "Rings are labeled in mph. The red arrow points at the compass direction the prevailing wind comes from." +
    res + src;
}

/** Single-provider mode: one rose, provider label hidden. */
function renderWindRose(data, provider) {
  drawWindRose($("wind-rose"), data, "Select wind speed + direction to see the wind rose.");
  $("rose-ms").hidden = true;
  $("rose-label-om").hidden = true;
  const noteEl = document.getElementById("wind-rose-note");
  if (noteEl) noteEl.innerHTML = windRoseNote(data, provider);
}

/** Empty-rose message for compare mode: no data vs. wind not served here. */
function roseEmptyMsg(data, providerName, windSelected) {
  if (!data) return `No ${providerName} data for these variables.`;
  if (!windSelected) return "Select wind speed + direction to see the wind rose.";
  return `${providerName} doesn't report wind at this aggregation.`;
}

/** Compare mode: two roses side by side, one per provider. */
function renderWindRoseCompare(omData, msData, vars) {
  const windSelected = vars.some((v) => v.key === "wind_speed_10m" || v.key === "wind_direction_10m");
  drawWindRose($("wind-rose"), omData, roseEmptyMsg(omData, "Open-Meteo", windSelected));
  drawWindRose($("wind-rose-ms"), msData, roseEmptyMsg(msData, "Meteostat", windSelected));
  $("rose-ms").hidden = false;
  $("rose-label-om").hidden = false;
  const data = omData || msData;
  const noteEl = document.getElementById("wind-rose-note");
  if (noteEl) {
    noteEl.innerHTML =
      "Each wedge points in the compass direction the wind <em>comes from</em>; " +
      "its length is the average wind speed from that direction over the selected period. " +
      "Rings are labeled in mph. The red arrow points at the compass direction the prevailing wind comes from." +
      (data && data.resolution === "hourly"
        ? " Built from every hourly observation in the range."
        : " Built from one value per day (dominant direction and daily mean speed), " +
          "so expect a coarser picture than hourly mode.") +
      " Left: Open-Meteo (historic forecast data). Right: Meteostat (station data).";
  }
}
