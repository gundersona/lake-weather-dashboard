// Lake analysis: rank lakes by mean wind speed over a date range.
//
// The weather source follows the provider selector in Controls:
//  - Open-Meteo: daily wind means for every lake via the archive API's
//    multi-location support (100 lakes per request, 4 concurrent requests).
//  - Meteostat: daily wind interpolated from the nearest stations for each
//    lake (station-year files are cached, so lakes near the same stations
//    are cheap after the first fetch).
// Built for long, monthly-style periods — not hourly data.
// Uses the shared date range, month filter, and temperature/area filters from
// Controls: only days whose month is selected and whose daily mean temperature
// is in range contribute to each lake's average.
"use strict";

const ANALYSIS_BATCH = 100;
const ANALYSIS_CONCURRENCY = 4;
const ANALYSIS_FILE_CONCURRENCY = 8;
const ANALYSIS_MIN_DATE = "1940-01-01";

let analysisRunning = false;
let analysisAborter = null;

function analysisMean(values) {
  let sum = 0, n = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    sum += v;
    n++;
  }
  return n ? sum / n : null;
}

function initAnalysis() {
  refreshAnalysisScopeLabel();
  $("analysis-run").addEventListener("click", runAnalysis);
  $("analysis-cancel").addEventListener("click", () => {
    if (analysisAborter) analysisAborter.abort();
  });
}

/** Show which state the "Selected state" scope refers to. */
function refreshAnalysisScopeLabel() {
  const opt = document.querySelector('#analysis-scope option[value="state"]');
  if (!opt) return;
  const st = STATES.find((s) => s.code === currentStateCode);
  opt.textContent = st ? `Selected state (${st.name})` : "Selected state";
}

function setAnalysisStatus(msg, isError) {
  const el = $("analysis-status");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}

function setAnalysisProgress(frac, text) {
  $("analysis-bar").value = Math.round(frac * 100);
  $("analysis-progress-text").textContent = text;
}

/** Download every state's lake file (for the "all states" scope). */
async function fetchAllStateLakes(signal, onFile) {
  const entries = Object.entries(lakeIndex.states);
  const out = [];
  let next = 0, done = 0;
  async function worker() {
    while (next < entries.length) {
      if (signal.aborted) return;
      const entry = entries[next++];
      const resp = await fetch(`data/lakes/${entry[1]}`, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${entry[1]}`);
      out.push(...(await resp.json()));
      done++;
      onFile(done, entries.length);
    }
  }
  await Promise.all(Array.from({ length: ANALYSIS_FILE_CONCURRENCY }, worker));
  return out;
}

/** Daily wind (+ optional daily mean temperature) for up to 100 lakes over [start, end]. */
async function fetchBatchDaily(batch, start, end, signal, wantTemp) {
  const lats = batch.map((l) => l.lat.toFixed(4)).join(",");
  const lons = batch.map((l) => l.lon.toFixed(4)).join(",");
  const url = "https://archive-api.open-meteo.com/v1/archive" +
    `?latitude=${lats}&longitude=${lons}&start_date=${start}&end_date=${end}` +
    `&daily=${wantTemp ? "wind_speed_10m_mean,temperature_2m_mean" : "wind_speed_10m_mean"}` +
    "&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC";
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      // Multi-location returns an array; a single location returns one object.
      const arr = Array.isArray(data) ? data : [data];
      return arr.map((r) => {
        const d = (r || {}).daily || {};
        return {
          time: d.time || [],
          wind: d.wind_speed_10m_mean || [],
          temp: wantTemp ? d.temperature_2m_mean || [] : null,
        };
      });
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

/** Mean wind (mph) over days passing the shared month/temperature filters; null when unusable. */
function analysisLakeMean(lake, s, months, tempRange, tempActive) {
  const windVals = [];
  for (let i = 0; i < s.wind.length; i++) {
    const day = (s.time[i] || "").slice(0, 10);
    if (!months.includes(parseInt(day.slice(5, 7), 10))) continue;
    if (tempActive) {
      const t = s.temp ? s.temp[i] : null;
      if (t === null || t === undefined) continue;
      if (tempRange.min !== null && t < tempRange.min) continue;
      if (tempRange.max !== null && t > tempRange.max) continue;
    }
    windVals.push(s.wind[i]);
  }
  return analysisMean(windVals);
}

async function runAnalysis() {
  if (analysisRunning) return;
  refreshAnalysisScopeLabel();
  $("analysis-table-wrap").hidden = true;

  const scope = $("analysis-scope").value;
  let lakes = null;
  if (scope === "state") {
    if (!currentStateCode) {
      setAnalysisStatus("Select a state first (type it above or click it on the map).", true);
      return;
    }
    if (!currentLakes.length) {
      setAnalysisStatus("Lake data for this state isn't loaded yet — pick the state again.", true);
      return;
    }
    lakes = currentLakes;
  }

  // Shared date range from Controls; clamp to what the archive can serve
  // (kept local — the shared inputs are left untouched for the main section).
  let start = $("start-date").value;
  let end = $("end-date").value;
  if (!start || !end) {
    setAnalysisStatus("Choose both a From and a To date in Controls.", true);
    return;
  }
  if (start < ANALYSIS_MIN_DATE) start = ANALYSIS_MIN_DATE;
  const provider = $("provider").value;
  const maxEnd = maxEndDate(provider, "daily");
  if (end > maxEnd) end = maxEnd;
  if (start > end) {
    setAnalysisStatus("From date must be on or before the To date.", true);
    return;
  }

  const months = getActiveMonths();
  if (!months.length) {
    setAnalysisStatus("Select at least one month in the Months filter.", true);
    return;
  }
  const tempRange = getTempRange();
  const tempActive = tempRange.min !== null || tempRange.max !== null;

  analysisRunning = true;
  analysisAborter = new AbortController();
  const signal = analysisAborter.signal;
  $("analysis-run").disabled = true;
  $("analysis-cancel").hidden = false;
  $("analysis-progress").hidden = false;
  setAnalysisStatus("");

  try {
    if (scope === "all") {
      setAnalysisStatus("Downloading the lake catalogue for all 50 states…");
      setAnalysisProgress(0, "0 / 50 state files");
      lakes = await fetchAllStateLakes(signal, (d, n) =>
        setAnalysisProgress((d / n) * 0.05, `${d} / ${n} state files`));
    }
    if (signal.aborted) return;

    // Shared surface-area filter from Controls. Lakes with no NHD area data
    // can't be verified against the filter, so they're excluded when active.
    const areaRange = getAreaRange();
    let areaExcluded = 0;
    if (areaRange.min !== null || areaRange.max !== null) {
      const before = lakes.length;
      lakes = lakes.filter(lakePassesAreaFilter);
      areaExcluded = before - lakes.length;
    }
    if (!lakes.length) {
      setAnalysisStatus("No lakes match the area filter.", true);
      return;
    }

    const dir = $("analysis-dir").value;
    const topN = parseInt($("analysis-top").value, 10) || 25;
    const isMeteostat = provider === "meteostat";
    const batches = [];
    for (let i = 0; i < lakes.length; i += ANALYSIS_BATCH) {
      batches.push(lakes.slice(i, i + ANALYSIS_BATCH));
    }
    const results = [];
    let failed = 0, processed = 0, next = 0;
    setAnalysisStatus(
      isMeteostat
        ? `Fetching Meteostat wind data for ${lakes.length.toLocaleString()} lakes (interpolated from nearby stations)…`
        : `Fetching wind data for ${lakes.length.toLocaleString()} lakes in batches of ${ANALYSIS_BATCH}…`);
    function tally(lake, s) {
      if (!s) { failed++; return; }
      const m = analysisLakeMean(lake, s, months, tempRange, tempActive);
      if (m === null || m === undefined) failed++;
      else results.push({ lake, mean: m });
    }
    async function omWorker() {
      while (next < batches.length) {
        if (signal.aborted) return;
        const batch = batches[next++];
        try {
          const series = await fetchBatchDaily(batch, start, end, signal, tempActive);
          for (let k = 0; k < batch.length; k++) tally(batch[k], series[k]);
        } catch (err) {
          if (signal.aborted) return;
          failed += batch.length;
        }
        processed += batch.length;
        setAnalysisProgress(
          0.05 + 0.95 * (processed / lakes.length),
          `${processed.toLocaleString()} / ${lakes.length.toLocaleString()} lakes`);
      }
    }
    async function msWorker() {
      while (next < lakes.length) {
        if (signal.aborted) return;
        const lake = lakes[next++];
        try {
          tally(lake, await msFetchLakeDaily(lake.lat, lake.lon, start, end, signal));
        } catch (err) {
          if (signal.aborted) return;
          failed++;
        }
        processed++;
        setAnalysisProgress(
          0.05 + 0.95 * (processed / lakes.length),
          `${processed.toLocaleString()} / ${lakes.length.toLocaleString()} lakes`);
      }
    }
    await Promise.all(Array.from({ length: ANALYSIS_CONCURRENCY },
      isMeteostat ? msWorker : omWorker));
    if (signal.aborted) return;

    results.sort((a, b) => (dir === "asc" ? a.mean - b.mean : b.mean - a.mean));
    renderAnalysisTable(results.slice(0, topN), scope === "all");
    $("analysis-table-wrap").hidden = false;
    const notes = [];
    if (months.length < 12) notes.push(`months: ${months.map((m) => MONTH_ABBR[m - 1]).join(", ")}`);
    if (tempActive) notes.push(`daily mean temp ${tempRange.min ?? "…"}–${tempRange.max ?? "…"}°F`);
    if (areaExcluded) notes.push(`${areaExcluded.toLocaleString()} excluded by the area filter`);
    if (failed) notes.push(`${failed.toLocaleString()} had no usable data`);
    setAnalysisStatus(
      `Ranked ${results.length.toLocaleString()} lakes by average wind, ${start} to ${end}` +
      ` (${provider === "meteostat" ? "Meteostat station interpolation" : "Open-Meteo archive"})` +
      (notes.length ? " — " + notes.join("; ") + "." : "."));
  } catch (err) {
    if (!signal.aborted) {
      setAnalysisStatus(err.message || "Analysis failed.", true);
      console.error(err);
    }
  } finally {
    const wasAborted = signal.aborted;
    analysisRunning = false;
    analysisAborter = null;
    $("analysis-run").disabled = false;
    $("analysis-cancel").hidden = true;
    $("analysis-progress").hidden = true;
    if (wasAborted) setAnalysisStatus("Cancelled.");
  }
}

function renderAnalysisTable(rows, showState) {
  const thead = document.querySelector("#analysis-table thead");
  const tbody = document.querySelector("#analysis-table tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";
  const cols = ["#", "Lake", "County"];
  if (showState) cols.push("State");
  cols.push("Area (acres)", "Avg wind (mph)", "");
  const headRow = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    const cells = [String(i + 1), r.lake.name, r.lake.county || "—"];
    if (showState) cells.push(r.lake.state);
    cells.push(formatAcres(r.lake.area_km2));
    cells.push(r.mean.toFixed(1));
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    const btnCell = document.createElement("td");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Load";
    btn.addEventListener("click", () => loadAnalysisLake(r.lake));
    btnCell.appendChild(btn);
    tr.appendChild(btnCell);
    tbody.appendChild(tr);
  });
}

/** Load an analysis result into the main weather section. */
async function loadAnalysisLake(lake) {
  await onStateChange(lake.state);
  // Markers are keyed by the lake objects from the fresh load — look it up
  // so the map highlight and popup work.
  const live = currentLakes.find((l) => l.id === lake.id) || lake;
  selectLake(live, { zoom: true });
  document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
}

document.addEventListener("DOMContentLoaded", initAnalysis);
