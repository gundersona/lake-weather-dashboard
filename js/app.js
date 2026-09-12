// Lake Weather Dashboard — main application wiring.
"use strict";

/* global L, Chart, STATES, VARIABLES, PROVIDERS, fetchWeather, getSelectedLake */

const ROWS_PER_PAGE = 25;
const COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                   "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
/** Variable keys with no Open-Meteo daily equivalent (hourly aggregation only). */
const HOURLY_ONLY_KEYS = ["relative_humidity_2m", "surface_pressure"];

let map = null;
let lakeMarker = null;
let lineChart = null;
let barChart = null;
let tableRows = [];
let tableVars = [];
let tablePage = 0;

const $ = (id) => document.getElementById(id);

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

// ---------------------------------------------------------------- init

document.addEventListener("DOMContentLoaded", init);

function init() {
  setDefaultDates();
  initMap();
  window.__onLakeSelected = onLakeSelected;
  $("load-btn").addEventListener("click", onLoad);
  $("prev-page").addEventListener("click", () => changePage(-1));
  $("next-page").addEventListener("click", () => changePage(1));
  $("provider").addEventListener("change", maybeProviderNotice);
}

function setDefaultDates() {
  const d = (daysAgo) => {
    const t = new Date();
    t.setDate(t.getDate() - daysAgo);
    return t.toISOString().slice(0, 10);
  };
  $("end-date").value = d(10);
  $("start-date").value = d(40);
}

function initMap() {
  if (typeof L === "undefined") {
    $("map").innerHTML = '<p class="empty-note">Map library failed to load.</p>';
    return;
  }
  map = L.map("map").setView([39.8, -98.5], 4);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}

function onLakeSelected(lake) {
  if (!map) return;
  if (lakeMarker) map.removeLayer(lakeMarker);
  lakeMarker = L.marker([lake.lat, lake.lon]).addTo(map);
  lakeMarker.bindPopup(
    `<b>${esc(lake.name)}</b><br>${esc(lake.county || "unknown county")}, ${esc(lake.state)}` +
    `<br>${lake.lat.toFixed(3)}, ${lake.lon.toFixed(3)}`
  ).openPopup();
  map.setView([lake.lat, lake.lon], 9);
}

function maybeProviderNotice() {
  if ($("provider").value === "meteostat") {
    setStatus("Meteostat needs a server-side API key and isn't available in this static build — please use Open-Meteo.", false);
  } else {
    setStatus("");
  }
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
  if (!start || !end) { setStatus("Please choose both a start and an end date.", true); return; }

  let vars = selectedVariables();
  if (vars.length === 0) { setStatus("Please select at least one variable.", true); return; }

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

  const btn = $("load-btn");
  btn.disabled = true;
  btn.textContent = "Loading…";
  setStatus(`Fetching ${provider === "open-meteo" ? "Open-Meteo" : "Meteostat"} data for ${lake.name}…`);

  try {
    const data = await fetchWeather(provider, lake.lat, lake.lon, start, end, params, aggregation);
    if (!data.time.length) throw new Error("No data returned for this date range.");

    const buckets = aggregate(data, vars, aggregation);
    renderStatCards(data, vars);
    renderLineChart(buckets, vars);
    renderBarChart(data, vars, aggregation);
    buildTable(buckets, vars);
    renderWindRose(data);

    let msg = `Loaded ${buckets.length} ${aggregation} period${buckets.length === 1 ? "" : "s"} for ${lake.name} (${start} to ${end}).`;
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
 * daily min/max temperature separately (Open-Meteo has no daily mean), so min
 * and max stats read those instead of the (max+min)/2 mean series.
 */
function seriesFor(data, varDef, stat) {
  if (data.resolution === "daily" && varDef.key === "temperature_2m" &&
      (stat === "min" || stat === "max")) {
    const extra = data.values[`temperature_2m_${stat}`];
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

function renderLineChart(buckets, vars) {
  if (lineChart) { lineChart.destroy(); lineChart = null; }
  if (typeof Chart === "undefined") return;

  const labels = buckets.map((b) => b.label);
  const unitToAxis = new Map();
  const scales = {};
  let axisCount = 0;

  for (const v of vars) {
    if (!unitToAxis.has(v.unit)) {
      const id = `y${axisCount++}`;
      unitToAxis.set(v.unit, id);
      scales[id] = {
        type: "linear",
        display: true,
        position: axisCount === 1 ? "left" : "right",
        title: { display: true, text: `${v.label} (${v.unit})` },
        grid: { drawOnChartArea: axisCount === 1 },
      };
    }
  }

  const datasets = vars.map((v) => ({
    label: `${v.label} (${v.unit})`,
    data: buckets.map((b) => primaryStat(v.key, b.stats[v.key])),
    borderColor: v.color,
    backgroundColor: v.color,
    yAxisID: unitToAxis.get(v.unit),
    tension: 0.15,
    pointRadius: 0,
    spanGaps: true,
  }));

  lineChart = new Chart($("line-chart"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top" } },
      scales: {
        x: { ticks: { maxTicksLimit: 14, maxRotation: 45 } },
        ...scales,
      },
    },
  });
}

// ---------------------------------------------------------------- bar chart

function renderBarChart(data, vars, aggregation) {
  if (barChart) { barChart.destroy(); barChart = null; }
  const canvas = $("bar-chart");
  const card = canvas.closest(".card");
  const oldNote = card.querySelector(".empty-note");
  if (oldNote) oldNote.remove();
  canvas.style.display = "";
  if (typeof Chart === "undefined") return;

  const precip = vars.find((v) => v.key === "precipitation");
  const temp = vars.find((v) => v.key === "temperature_2m");
  // Bars are always daily or coarser (hourly is re-bucketed to daily).
  const mode = aggregation === "hourly" ? "daily" : aggregation;

  let target, label, color, valueFn;
  if (precip) {
    target = precip; label = `Precipitation total (${precip.unit})`;
    color = precip.color; valueFn = (s) => s.total;
  } else if (temp) {
    target = temp; label = `Mean temperature (${temp.unit})`;
    color = temp.color; valueFn = (s) => s.mean;
  } else {
    canvas.style.display = "none";
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = "Select precipitation or temperature to see the bar chart.";
    card.appendChild(note);
    return;
  }

  const buckets = aggregate(data, [target], mode);
  barChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: buckets.map((b) => b.label),
      datasets: [{
        label,
        data: buckets.map((b) => valueFn(b.stats[target.key])),
        backgroundColor: color,
        borderColor: color,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 14, maxRotation: 45 } },
        y: { title: { display: true, text: target.unit } },
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
    th.textContent = `${v.label} (${v.unit})`;
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
    ctx.fillText(`${(maxMean * f).toFixed(1)}`, cx + 4, cy - R * f - 3);
  }
  ctx.fillText(windSpeedUnit(), cx + 4, cy - R - 15);

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
}
