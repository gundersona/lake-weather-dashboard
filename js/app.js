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
let tableRows = [];
let tableVars = [];
let tablePage = 0;

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
  $("provider").addEventListener("change", maybeProviderNotice);
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
  $("end-date").value = d(0); // "To" always defaults to the current date on load
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
  if ($("provider").value === "meteostat") {
    setStatus("Meteostat needs a server-side API key and isn't available in this static build — please use Open-Meteo.", false);
  } else {
    setStatus("");
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

/** Human-readable summary of the active shared filters, for status lines. */
function describeActiveFilters() {
  const parts = [];
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

  // Humidity and pressure have no Open-Meteo daily equivalent; they only work hourly.
  let skipped = [];
  if (aggregation !== "hourly") {
    skipped = vars.filter((v) => HOURLY_ONLY_KEYS.includes(v.key));
    vars = vars.filter((v) => !HOURLY_ONLY_KEYS.includes(v.key));
  }
  if (vars.length === 0) {
    setStatus("None of the selected variables are available for " + aggregation +
      " aggregation — humidity and pressure need hourly.", true);
    return;
  }
  const params = vars.map((v) => v.param);

  // The temperature filter needs temperature data even when it's unchecked —
  // fetch it silently and keep it out of the displayed variables.
  const tempRange = getTempRange();
  const tempActive = tempRange.min !== null || tempRange.max !== null;
  const fetchParams = [...params];
  if (tempActive && !fetchParams.includes("temperature_2m")) fetchParams.push("temperature_2m");

  const btn = $("load-btn");
  btn.disabled = true;
  btn.textContent = "Loading…";
  setStatus(`Fetching ${provider === "open-meteo" ? "Open-Meteo" : "Meteostat"} data for ${lake.name}…`);

  try {
    const data = await fetchWeather(provider, lake.lat, lake.lon, start, end, fetchParams, aggregation);
    if (!data.time.length) throw new Error("No data returned for this date range.");

    // Shared month + temperature filters: keep whole days whose month is
    // selected and whose daily mean temperature is in range (hourly mode
    // derives the daily mean from the 24 hourly values).
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
    if (!keepDays.size) throw new Error("No days in the selected range match the month/temperature filters.");
    const fdata = filterDataToDays(data, keepDays);

    const buckets = aggregate(fdata, vars, aggregation);
    renderStatCards(fdata, vars);
    renderLineChart(buckets, vars, aggregation);
    buildTable(buckets, vars);
    renderWindRose(fdata);

    $("visuals").hidden = false;

    let msg = `Loaded ${buckets.length} ${aggregation} period${buckets.length === 1 ? "" : "s"} for ${lake.name} (${start} to ${end}).` +
      describeActiveFilters();
    if (skipped.length) {
      msg += ` Skipped ${skipped.map((v) => v.label).join(", ")} (hourly aggregation only).`;
    }
    setStatus(msg);
  } catch (err) {
    setStatus(err.message || "Something went wrong while loading weather data.", true);
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Load weather";
  }
}

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
  if (data.resolution === "daily") {
    if (varDef.key === "temperature_2m" && (stat === "min" || stat === "max")) {
      const extra = data.values[`temperature_2m_${stat}`];
      if (Array.isArray(extra)) return extra;
    }
    if (varDef.key === "wind_speed_10m" && stat === "max") {
      const extra = data.values["wind_speed_10m_max"];
      if (Array.isArray(extra)) return extra;
    }
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
      big = `${fmt(s.mean)} ${v.unit}`;
      const parts = [];
      if (s.min !== null && s.min !== undefined) parts.push(`min ${fmt(s.min)}`);
      if (s.max !== null && s.max !== undefined) parts.push(`max ${fmt(s.max)}`);
      sub = parts.join(" · ") + (parts.length ? ` ${v.unit}` : "no data");
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

// ---------------------------------------------------------------- line chart

function renderLineChart(buckets, vars, aggregation) {
  if (lineChart) { lineChart.destroy(); lineChart = null; }
  if (typeof Chart === "undefined") return;

  const labels = buckets.map((b) => b.label);
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
    data: buckets.map((b) => primaryStat(v.key, b.stats[v.key])),
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

function buildTable(buckets, vars) {
  tableVars = vars;
  tableRows = buckets.map((b) => ({
    label: b.label,
    cells: vars.map((v) => formatCell(v, b.stats)),
  }));
  tablePage = 0;
  renderTable();
}

function renderTable() {
  const thead = $("data-table").querySelector("thead");
  const tbody = $("data-table").querySelector("tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";

  const hr = document.createElement("tr");
  const th0 = document.createElement("th");
  th0.textContent = "Period";
  hr.appendChild(th0);
  for (const v of tableVars) {
    const th = document.createElement("th");
    const headerStat = v.key === "precipitation" ? "total"
      : v.key === "wind_direction_10m" ? "prevailing" : "avg / min / max";
    th.textContent = `${v.label} (${v.unit}) — ${headerStat}`;
    hr.appendChild(th);
  }
  thead.appendChild(hr);

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
    td.colSpan = tableVars.length + 1;
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

// ---------------------------------------------------------------- wind rose

function renderWindRose(data) {
  const windSpeedUnit = () =>
    (VARIABLES.find((v) => v.key === "wind_speed_10m") || {}).unit || "mph";
  const canvas = $("wind-rose");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const speeds = data.values["wind_speed_10m"] || [];
  const dirs = data.values["wind_direction_10m"] || [];
  if (!speeds.length || !dirs.length) {
    ctx.fillStyle = "#6b7c8d";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Select wind speed + direction to see the wind rose.", W / 2, H / 2);
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

  // Explain the data source: hourly mode uses every observation, daily/monthly
  // mode uses one (dominant direction, mean speed) pair per day.
  const noteEl = document.getElementById("wind-rose-note");
  if (noteEl) {
    noteEl.innerHTML =
      "Each wedge points in the compass direction the wind <em>comes from</em>; " +
      "its length is the average wind speed from that direction over the selected period. " +
      "Rings are labeled in mph. The red arrow points at the compass direction the prevailing wind comes from." +
      (data.resolution === "hourly"
        ? " Built from every hourly observation in the range."
        : " Built from one value per day (dominant direction and daily mean speed), " +
          "so expect a coarser picture than hourly mode.");
  }
}
