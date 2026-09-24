// Wind-day ranking: rank lakes by the number of days in the shared date range
// on which the hourly wind speed stayed inside a chosen range for at least a
// chosen number of hours that day. Hourly data only; structured like the lake
// analysis section (scope, run/cancel, progress, results table with Load).
//
// The weather source follows the provider selector in Controls:
//  - Open-Meteo: hourly wind for every lake via the archive API's
//    multi-location support (100 lakes per request, 4 concurrent requests).
//  - Meteostat: hourly wind interpolated from the nearest stations for each
//    lake (station-year files are cached, so lakes near the same stations
//    are cheap after the first fetch).
// The shared months, temperature-range, and area filters apply, plus the
// 24hr/daylight toggle (daylight keeps only sunrise-to-sunset hours, computed
// per lake with the same NOAA solar equations as the main view).
"use strict";

const WINDRANK_BATCH = 100;
const WINDRANK_CONCURRENCY = 4;

let windrankRunning = false;
let windrankAborter = null;

function initWindRank() {
  refreshWindRankScopeLabel();
  refreshRankByRow();
  $("provider").addEventListener("change", refreshRankByRow);
  $("windrank-run").addEventListener("click", runWindRank);
  $("windrank-cancel").addEventListener("click", () => {
    if (windrankAborter) windrankAborter.abort();
  });
  const slider = $("windrank-hours");
  const update = () => {
    $("windrank-hours-val").textContent = `≥ ${slider.value} h`;
  };
  slider.addEventListener("input", update);
  update();
}

/** Show which state the "Selected state" scope refers to. */
function refreshWindRankScopeLabel() {
  const opt = document.querySelector('#windrank-scope option[value="state"]');
  if (!opt) return;
  const st = STATES.find((s) => s.code === currentStateCode);
  opt.textContent = st ? `Selected state (${st.name})` : "Selected state";
}

/** Show the rank-by-provider picker only when both providers are compared. */
function refreshRankByRow() {
  $("windrank-rankby-row").hidden = $("provider").value !== "both";
}

function setWindRankStatus(msg, isError) {
  const el = $("windrank-status");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}

function setWindRankProgress(frac, text) {
  $("windrank-bar").value = Math.round(frac * 100);
  $("windrank-progress-text").textContent = text;
}

/** Hourly wind (+ optional hourly temperature) for up to 100 lakes over [start, end]. */
async function fetchBatchHourly(batch, start, end, signal, wantTemp) {
  const lats = batch.map((l) => l.lat.toFixed(4)).join(",");
  const lons = batch.map((l) => l.lon.toFixed(4)).join(",");
  const url = "https://archive-api.open-meteo.com/v1/archive" +
    `?latitude=${lats}&longitude=${lons}&start_date=${start}&end_date=${end}` +
    `&hourly=${wantTemp ? "wind_speed_10m,temperature_2m" : "wind_speed_10m"}` +
    "&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC";
  // Three attempts; 429s back off longer and honor the server's Retry-After
  // header when present (Open-Meteo throttles aggressive batch patterns).
  const backoffs = [1500, 5000, 15000];
  let lastErr = null;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    let waitMs = backoffs[attempt];
    try {
      const resp = await fetch(url, { signal });
      if (resp.status === 429) {
        const retryAfter = parseFloat(resp.headers.get("Retry-After"));
        if (Number.isFinite(retryAfter) && retryAfter >= 0) waitMs = retryAfter * 1000;
        lastErr = new Error("HTTP 429");
      } else if (!resp.ok) {
        lastErr = new Error(`HTTP ${resp.status}`);
      } else {
        const data = await resp.json();
        // Multi-location returns an array; a single location returns one object.
        const arr = Array.isArray(data) ? data : [data];
        return arr.map((r) => {
          const h = (r || {}).hourly || {};
          return {
            time: h.time || [],
            wind: h.wind_speed_10m || [],
            temp: wantTemp ? h.temperature_2m || [] : null,
          };
        });
      }
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
    }
    if (attempt < backoffs.length - 1 && !signal.aborted) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr || new Error("Request failed");
}

/**
 * Count the days in one lake's hourly series that match the criteria: at
 * least hourThreshold hours with wind inside [wmin, wmax], on a selected
 * month, with the daily mean temperature in range when the temp filter is
 * active. s is { time: [ISO], wind: [mph|null], temp: [F|null] }, UTC hourly.
 * Hours with no wind data never count toward the threshold.
 */
function windrankLakeDays(lake, s, months, tempRange, tempActive, wmin, wmax, hourThreshold, useDaylight) {
  let times = s.time, winds = s.wind, temps = s.temp;
  if (useDaylight) {
    const f = filterDaylight(
      { time: times, values: { wind: winds, temp: temps || winds.map(() => null) } },
      lake.lat, lake.lon, null);
    times = f.time;
    winds = f.values.wind;
    temps = f.values.temp;
  }
  const days = new Map(); // ymd -> { qual, tSum, tN }
  for (let i = 0; i < times.length; i++) {
    const ymd = times[i].slice(0, 10);
    if (!months.includes(parseInt(ymd.slice(5, 7), 10))) continue;
    let e = days.get(ymd);
    if (!e) { e = { qual: 0, tSum: 0, tN: 0 }; days.set(ymd, e); }
    const w = winds[i];
    if (w !== null && w !== undefined && w >= wmin && w <= wmax) e.qual++;
    const t = temps ? temps[i] : null;
    if (t !== null && t !== undefined) { e.tSum += t; e.tN++; }
  }
  let matchDays = 0;
  for (const e of days.values()) {
    if (e.qual < hourThreshold) continue;
    if (tempActive) {
      if (!e.tN) continue;
      const mean = e.tSum / e.tN;
      if (tempRange.min !== null && mean < tempRange.min) continue;
      if (tempRange.max !== null && mean > tempRange.max) continue;
    }
    matchDays++;
  }
  return matchDays;
}

async function runWindRank() {
  if (windrankRunning) return;
  refreshWindRankScopeLabel();
  $("windrank-table-wrap").hidden = true;

  const wmin = parseFloat($("windrank-wind-min").value);
  const wmax = parseFloat($("windrank-wind-max").value);
  if (!Number.isFinite(wmin) || !Number.isFinite(wmax)) {
    setWindRankStatus("Enter a wind range (min and max, mph).", true);
    return;
  }
  if (wmin > wmax) {
    setWindRankStatus("Min wind must be at or below max wind.", true);
    return;
  }
  const hourThreshold = parseInt($("windrank-hours").value, 10) || 12;

  const scope = $("windrank-scope").value;
  let lakes = null;
  if (scope === "state") {
    if (!currentStateCode) {
      setWindRankStatus("Select a state first (type it above or click it on the map).", true);
      return;
    }
    if (!currentLakes.length) {
      setWindRankStatus("Lake data for this state isn't loaded yet — pick the state again.", true);
      return;
    }
    lakes = currentLakes;
  }

  // Shared date range from Controls; hourly reach is 30 years (matches the
  // main weather view's limit) and each provider is clamped to its freshness
  // limit. Kept local — the shared inputs are left untouched.
  let start = $("start-date").value;
  let end = $("end-date").value;
  if (!start || !end) {
    setWindRankStatus("Choose both a From and a To date in Controls.", true);
    return;
  }
  const minStart = yearsAgoISO(30);
  if (start < minStart) start = minStart;
  const provider = $("provider").value;
  const isCompare = provider === "both";
  const omEnd = end > maxEndDate("open-meteo", "hourly") ? maxEndDate("open-meteo", "hourly") : end;
  const msEnd = end > maxEndDate("meteostat", "hourly") ? maxEndDate("meteostat", "hourly") : end;
  if (!isCompare) {
    const maxEnd = maxEndDate(provider, "hourly");
    if (end > maxEnd) end = maxEnd;
  }
  if (start > end) {
    setWindRankStatus("From date must be on or before the To date.", true);
    return;
  }

  const months = getActiveMonths();
  if (!months.length) {
    setWindRankStatus("Select at least one month in the Months filter.", true);
    return;
  }
  const tempRange = getTempRange();
  const tempActive = tempRange.min !== null || tempRange.max !== null;
  const useDaylight = daylightOnly();

  windrankRunning = true;
  windrankAborter = new AbortController();
  const signal = windrankAborter.signal;
  $("windrank-run").disabled = true;
  $("windrank-cancel").hidden = false;
  $("windrank-progress").hidden = false;
  setWindRankStatus("");

  try {
    if (scope === "all") {
      setWindRankStatus("Downloading the lake catalogue for all 50 states…");
      setWindRankProgress(0, "0 / 50 state files");
      lakes = await fetchAllStateLakes(signal, (d, n) =>
        setWindRankProgress((d / n) * 0.05, `${d} / ${n} state files`));
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
      setWindRankStatus("No lakes match the area filter.", true);
      return;
    }

    const days = daysBetween(start, end) + 1;
    const topN = parseInt($("windrank-top").value, 10) || 25;
    const isMeteostat = provider === "meteostat";
    const batches = [];
    for (let i = 0; i < lakes.length; i += WINDRANK_BATCH) {
      batches.push(lakes.slice(i, i + WINDRANK_BATCH));
    }
    const results = [];
    let failed = 0, processed = 0, next = 0;
    // Compare mode: phase 1 stores each lake's Open-Meteo day count here for
    // phase 2 (Meteostat) to join against — only one number per lake, so
    // even the all-states scope stays light on memory.
    const omDayCounts = new Map();
    function tally(lake, s) {
      if (!s) { failed++; return; }
      const d = windrankLakeDays(lake, s, months, tempRange, tempActive,
        wmin, wmax, hourThreshold, useDaylight);
      if (d === null || d === undefined) failed++;
      else results.push({ lake, days: d });
    }
    async function omWorker() {
      while (next < batches.length) {
        if (signal.aborted) return;
        const batch = batches[next++];
        try {
          const series = await fetchBatchHourly(batch, start, end, signal, tempActive);
          for (let k = 0; k < batch.length; k++) tally(batch[k], series[k]);
        } catch (err) {
          if (signal.aborted) return;
          failed += batch.length;
        }
        processed += batch.length;
        setWindRankProgress(
          0.05 + 0.95 * (processed / lakes.length),
          `${processed.toLocaleString()} / ${lakes.length.toLocaleString()} lakes`);
      }
    }
    async function msWorker() {
      while (next < lakes.length) {
        if (signal.aborted) return;
        const lake = lakes[next++];
        try {
          tally(lake, await msFetchLakeHourly(lake.lat, lake.lon, start, end, signal));
        } catch (err) {
          if (signal.aborted) return;
          failed++;
        }
        processed++;
        setWindRankProgress(
          0.05 + 0.95 * (processed / lakes.length),
          `${processed.toLocaleString()} / ${lakes.length.toLocaleString()} lakes`);
      }
    }
    const hourlyVals = lakes.length * days * 24;
    const costNote = `${lakes.length.toLocaleString()} lakes × ${days.toLocaleString()} days` +
      ` (~${hourlyVals >= 1e6 ? Math.round(hourlyVals / 1e6).toLocaleString() + "M" : Math.round(hourlyVals / 1e3).toLocaleString() + "K"} hourly values` +
      (isCompare ? " per provider" : "") + ")";
    if (!isCompare) {
      setWindRankStatus(
        `Fetching hourly wind for ${costNote}… ` +
        (isMeteostat
          ? "(Meteostat station interpolation)"
          : "(Open-Meteo archive, 100 lakes per request)"));
      await Promise.all(Array.from({ length: WINDRANK_CONCURRENCY },
        isMeteostat ? msWorker : omWorker));
    } else {
      // Phase 1: Open-Meteo batch day counts. Batches that fail (usually
      // transient rate limiting) get one sequential retry pass before their
      // lakes are counted as failed.
      setWindRankStatus(`Fetching Open-Meteo hourly wind for ${costNote}…`);
      const retryBatches = [];
      async function processOmBatch(batch) {
        const series = await fetchBatchHourly(batch, start, omEnd, signal, tempActive);
        for (let k = 0; k < batch.length; k++) {
          const d = windrankLakeDays(batch[k], series[k], months, tempRange,
            tempActive, wmin, wmax, hourThreshold, useDaylight);
          if (d === null || d === undefined) failed++;
          else omDayCounts.set(batch[k], d);
        }
      }
      async function omPhaseWorker() {
        while (next < batches.length) {
          if (signal.aborted) return;
          const batch = batches[next++];
          try {
            await processOmBatch(batch);
          } catch (err) {
            if (signal.aborted) return;
            retryBatches.push(batch);
          }
          processed += batch.length;
          setWindRankProgress(
            0.05 + 0.45 * (processed / lakes.length),
            `Open-Meteo: ${processed.toLocaleString()} / ${lakes.length.toLocaleString()} lakes`);
        }
      }
      await Promise.all(Array.from({ length: WINDRANK_CONCURRENCY }, omPhaseWorker));
      if (signal.aborted) return;
      // Phase 1b: sequential retry pass for batches that failed above. By now
      // the workers are done, so this also spaces requests out, which helps
      // when the failures were rate limiting (HTTP 429).
      for (const batch of retryBatches) {
        if (signal.aborted) return;
        try {
          await processOmBatch(batch);
        } catch (err) {
          if (signal.aborted) return;
          failed += batch.length;
        }
      }
      if (signal.aborted) return;
      // Phase 2: Meteostat per-lake day counts, joined with phase 1. Lakes
      // missing the Open-Meteo count were already counted as failed.
      next = 0; processed = 0;
      setWindRankStatus(`Fetching Meteostat hourly wind for ${costNote}…`);
      async function msPhaseWorker() {
        while (next < lakes.length) {
          if (signal.aborted) return;
          const lake = lakes[next++];
          try {
            const s = await msFetchLakeHourly(lake.lat, lake.lon, start, msEnd, signal);
            const omD = omDayCounts.get(lake);
            if (omD !== undefined) {
              const msD = s ? windrankLakeDays(lake, s, months, tempRange,
                tempActive, wmin, wmax, hourThreshold, useDaylight) : null;
              if (msD === null || msD === undefined) failed++;
              else results.push({ lake, omDays: omD, msDays: msD });
            }
          } catch (err) {
            if (signal.aborted) return;
            if (omDayCounts.get(lake) !== undefined) failed++;
          }
          processed++;
          setWindRankProgress(
            0.5 + 0.5 * (processed / lakes.length),
            `Meteostat: ${processed.toLocaleString()} / ${lakes.length.toLocaleString()} lakes`);
        }
      }
      await Promise.all(Array.from({ length: WINDRANK_CONCURRENCY }, msPhaseWorker));
    }
    if (signal.aborted) return;

    // Most matching days first; ties broken by name for a stable table.
    // Compare mode sorts by the selected provider's day count ("Days
    // matching" semantics in single-provider mode); the Δ column shows the
    // other provider's difference.
    const rankByMs = isCompare && $("windrank-rankby").value === "meteostat";
    results.sort((a, b) => {
      const ad = isCompare ? (rankByMs ? a.msDays : a.omDays) : a.days;
      const bd = isCompare ? (rankByMs ? b.msDays : b.omDays) : b.days;
      return (bd - ad) || a.lake.name.localeCompare(b.lake.name);
    });
    renderWindRankTable(results.slice(0, topN), scope === "all", isCompare);
    $("windrank-table-wrap").hidden = false;
    const notes = [
      `wind ${wmin}–${wmax} mph for ≥${hourThreshold} h/day`,
      useDaylight ? "daylight hours only" : "all 24 hours",
    ];
    if (months.length < 12) notes.push(`months: ${months.map((m) => MONTH_ABBR[m - 1]).join(", ")}`);
    if (tempActive) notes.push(`daily mean temp ${tempRange.min ?? "…"}–${tempRange.max ?? "…"}°F`);
    if (areaExcluded) notes.push(`${areaExcluded.toLocaleString()} excluded by the area filter`);
    if (failed) notes.push(isCompare
      ? `${failed.toLocaleString()} had no usable data from one or both providers`
      : `${failed.toLocaleString()} had no usable data`);
    setWindRankStatus(
      `Ranked ${results.length.toLocaleString()} lakes by matching days, ${start} to ${end}` +
      (isCompare
        ? ` (both providers; sorted by ${rankByMs ? "Meteostat" : "Open-Meteo"} days, Δ = Meteostat − Open-Meteo)`
        : ` (${provider === "meteostat" ? "Meteostat station interpolation" : "Open-Meteo archive"})`) +
      " — " + notes.join("; ") + ".");
  } catch (err) {
    if (!signal.aborted) {
      setWindRankStatus(err.message || "Ranking failed.", true);
      console.error(err);
    }
  } finally {
    const wasAborted = signal.aborted;
    windrankRunning = false;
    windrankAborter = null;
    $("windrank-run").disabled = false;
    $("windrank-cancel").hidden = true;
    $("windrank-progress").hidden = true;
    if (wasAborted) setWindRankStatus("Cancelled.");
  }
}

function renderWindRankTable(rows, showState, isCompare = false) {
  const thead = document.querySelector("#windrank-table thead");
  const tbody = document.querySelector("#windrank-table tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";
  const cols = ["#", "Lake", "County"];
  if (showState) cols.push("State");
  cols.push("Area (acres)");
  if (isCompare) cols.push("OM days", "MS days", "Δ");
  else cols.push("Days matching");
  cols.push("");
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
    if (isCompare) {
      cells.push(String(r.omDays), String(r.msDays));
      const d = r.msDays - r.omDays;
      cells.push(`${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d)}`);
    } else {
      cells.push(String(r.days));
    }
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

document.addEventListener("DOMContentLoaded", initWindRank);
