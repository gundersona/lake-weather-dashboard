// Lake analysis: rank lakes by mean wind speed over a date range.
//
// Fetches Open-Meteo daily wind means for every lake in the scope using the
// archive API's multi-location support (100 lakes per request, 4 concurrent
// requests), averages each lake's daily means over the period, and ranks the
// lakes. Built for long, monthly-style periods — not hourly data.
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

function analysisISODate(daysAgo) {
  const t = new Date();
  t.setDate(t.getDate() - daysAgo);
  return t.toISOString().slice(0, 10);
}

function initAnalysis() {
  // Archive data lags ~5 days behind the present.
  $("analysis-end").value = analysisISODate(6);
  $("analysis-start").value = analysisISODate(371);
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

/** Mean daily wind speed (mph) for up to 100 lakes over [start, end]. */
async function fetchBatchMeans(batch, start, end, signal) {
  const lats = batch.map((l) => l.lat.toFixed(4)).join(",");
  const lons = batch.map((l) => l.lon.toFixed(4)).join(",");
  const url = "https://archive-api.open-meteo.com/v1/archive" +
    `?latitude=${lats}&longitude=${lons}&start_date=${start}&end_date=${end}` +
    "&daily=wind_speed_10m_mean&wind_speed_unit=mph&timezone=UTC";
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      // Multi-location returns an array; a single location returns one object.
      const arr = Array.isArray(data) ? data : [data];
      return arr.map((r) => analysisMean(((r || {}).daily || {}).wind_speed_10m_mean || []));
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
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

  // Clamp dates to what the archive can serve.
  const maxEnd = analysisISODate(5);
  let start = $("analysis-start").value;
  let end = $("analysis-end").value;
  if (!start || !end) {
    setAnalysisStatus("Choose both a start and an end date.", true);
    return;
  }
  if (start < ANALYSIS_MIN_DATE) start = ANALYSIS_MIN_DATE;
  if (end > maxEnd) end = maxEnd;
  if (start > end) {
    setAnalysisStatus("Start date must be on or before the end date.", true);
    return;
  }
  $("analysis-start").value = start;
  $("analysis-end").value = end;

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

    const dir = $("analysis-dir").value;
    const topN = parseInt($("analysis-top").value, 10) || 25;
    const batches = [];
    for (let i = 0; i < lakes.length; i += ANALYSIS_BATCH) {
      batches.push(lakes.slice(i, i + ANALYSIS_BATCH));
    }
    const results = [];
    let failed = 0, processed = 0, next = 0;
    setAnalysisStatus(`Fetching wind data for ${lakes.length.toLocaleString()} lakes in batches of ${ANALYSIS_BATCH}…`);
    async function worker() {
      while (next < batches.length) {
        if (signal.aborted) return;
        const batch = batches[next++];
        try {
          const means = await fetchBatchMeans(batch, start, end, signal);
          for (let k = 0; k < batch.length; k++) {
            if (means[k] === null || means[k] === undefined) failed++;
            else results.push({ lake: batch[k], mean: means[k] });
          }
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
    await Promise.all(Array.from({ length: ANALYSIS_CONCURRENCY }, worker));
    if (signal.aborted) return;

    results.sort((a, b) => (dir === "asc" ? a.mean - b.mean : b.mean - a.mean));
    renderAnalysisTable(results.slice(0, topN), scope === "all");
    $("analysis-table-wrap").hidden = false;
    setAnalysisStatus(
      `Ranked ${results.length.toLocaleString()} lakes by average wind, ${start} to ${end}` +
      (failed ? ` — ${failed.toLocaleString()} had no usable data.` : "."));
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
  cols.push("Avg wind (mph)", "");
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
