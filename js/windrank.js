// Wind ranking: rank lakes either by average hourly wind speed or by the
// number of days on which the hourly wind stayed inside a chosen range for
// at least a chosen number of hours. Hourly data only.
//
// The weather source follows the provider selector in Controls:
//  - Open-Meteo: hourly wind for every lake via the archive API's
//    multi-location support (100 lakes per request, 4 concurrent requests).
//  - Meteostat: hourly wind interpolated from the nearest stations for each
//    lake (station-year files are cached, so lakes near the same stations
//    are cheap after the first fetch).
// The shared months, temperature-range, and area filters apply to both
// criteria, plus the 24hr/daylight toggle (daylight keeps only
// sunrise-to-sunset hours, computed per lake with the same NOAA solar
// equations as the main view).
"use strict";

const WINDRANK_BATCH = 100;
const WINDRANK_CONCURRENCY = 4;
const WINDRANK_FILE_CONCURRENCY = 8;

let windrankRunning = false;
let windrankAborter = null;

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
  await Promise.all(Array.from({ length: WINDRANK_FILE_CONCURRENCY }, worker));
  return out;
}

/** Load a ranking result into the main weather section. */
async function loadRankedLake(lake) {
  await onStateChange(lake.state);
  // Markers are keyed by the lake objects from the fresh load — look it up
  // so the map highlight and popup work.
  const live = currentLakes.find((l) => l.id === lake.id) || lake;
  selectLake(live, { zoom: true });
  document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
}

function initWindRank() {
  refreshWindRankScopeLabel();
  refreshRankByRow();
  refreshCriteriaUI();
  $("provider").addEventListener("change", refreshRankByRow);
  $("windrank-criteria").addEventListener("change", refreshCriteriaUI);
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

/**
 * Show the wind-range/hour controls only for the "days in range" criterion;
 * the calmest/windiest order only for "average wind". Also retitles the
 * provider sort picker to match the active criterion.
 */
function refreshCriteriaUI() {
  const isAvg = $("windrank-criteria").value === "avg";
  document.querySelectorAll(".windrank-days-only").forEach((el) => { el.hidden = isAvg; });
  document.querySelectorAll(".windrank-avg-only").forEach((el) => { el.hidden = !isAvg; });
  const rb = $("windrank-rankby");
  rb.options[0].textContent = isAvg ? "Open-Meteo avg wind" : "Open-Meteo days";
  rb.options[1].textContent = isAvg ? "Meteostat avg wind" : "Meteostat days";
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
 * Group a lake's hourly series into per-day buckets after daylight and month
 * filtering. Each bucket: { winds: [mph|null], tSum, tN } over one UTC day.
 * Hours with no wind data are kept as null (they never count toward the
 * threshold, and are skipped in averages).
 */
function windrankDayBuckets(lake, s, months, useDaylight) {
  let times = s.time, winds = s.wind, temps = s.temp;
  if (useDaylight) {
    const f = filterDaylight(
      { time: times, values: { wind: winds, temp: temps || winds.map(() => null) } },
      lake.lat, lake.lon, null);
    times = f.time;
    winds = f.values.wind;
    temps = f.values.temp;
  }
  const days = [];
  const byDate = new Map();
  for (let i = 0; i < times.length; i++) {
    const ymd = times[i].slice(0, 10);
    if (!months.includes(parseInt(ymd.slice(5, 7), 10))) continue;
    let e = byDate.get(ymd);
    if (!e) { e = { winds: [], tSum: 0, tN: 0 }; byDate.set(ymd, e); days.push(e); }
    e.winds.push(winds[i]);
    const t = temps ? temps[i] : null;
    if (t !== null && t !== undefined) { e.tSum += t; e.tN++; }
  }
  return days;
}

/** Whole-day temperature filter: keep days whose mean (of retained hours) is in range. */
function windrankDayPassesTemp(e, tempRange, tempActive) {
  if (!tempActive) return true;
  if (!e.tN) return false;
  const mean = e.tSum / e.tN;
  if (tempRange.min !== null && mean < tempRange.min) return false;
  if (tempRange.max !== null && mean > tempRange.max) return false;
  return true;
}

/**
 * Count the days in one lake's hourly series that match the criteria: at
 * least hourThreshold hours with wind inside [wmin, wmax], on a selected
 * month, with the daily mean temperature in range when the temp filter is
 * active. s is { time: [ISO], wind: [mph|null], temp: [F|null] }, UTC hourly.
 * Hours with no wind data never count toward the threshold.
 */
function windrankLakeDays(lake, s, months, tempRange, tempActive, wmin, wmax, hourThreshold, useDaylight) {
  let matchDays = 0;
  for (const e of windrankDayBuckets(lake, s, months, useDaylight)) {
    if (!windrankDayPassesTemp(e, tempRange, tempActive)) continue;
    let qual = 0;
    for (const w of e.winds) {
      if (w !== null && w !== undefined && w >= wmin && w <= wmax) qual++;
    }
    if (qual >= hourThreshold) matchDays++;
  }
  return matchDays;
}

/**
 * Mean hourly wind (mph) over the days passing the shared filters; null when
 * there are no usable hours. Same filtering as the day-count criterion, so
 * both rankings answer to all filters.
 */
function windrankLakeAvg(lake, s, months, tempRange, tempActive, useDaylight) {
  let sum = 0, n = 0;
  for (const e of windrankDayBuckets(lake, s, months, useDaylight)) {
    if (!windrankDayPassesTemp(e, tempRange, tempActive)) continue;
    for (const w of e.winds) {
      if (w === null || w === undefined) continue;
      sum += w;
      n++;
    }
  }
  return n ? sum / n : null;
}

async function runWindRank() {
  if (windrankRunning) return;
  refreshWindRankScopeLabel();
  $("windrank-table-wrap").hidden = true;

  const criteria = $("windrank-criteria").value; // "days" | "avg"
  const isAvg = criteria === "avg";
  const avgDir = $("windrank-avgdir").value; // "asc" (calmest) | "desc" (windiest)

  let wmin, wmax, hourThreshold;
  if (!isAvg) {
    wmin = parseFloat($("windrank-wind-min").value);
    wmax = parseFloat($("windrank-wind-max").value);
    if (!Number.isFinite(wmin) || !Number.isFinite(wmax)) {
      setWindRankStatus("Enter a wind range (min and max, mph).", true);
      return;
    }
    if (wmin > wmax) {
      setWindRankStatus("Min wind must be at or below max wind.", true);
      return;
    }
    hourThreshold = parseInt($("windrank-hours").value, 10) || 4;
  }

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
    // Compare mode: phase 1 stores each lake's Open-Meteo value here for
    // phase 2 (Meteostat) to join against — only one number per lake, so
    // even the all-states scope stays light on memory.
    const omValues = new Map();
    /** One lake's ranking value under the active criterion (null when unusable). */
    function tallyValue(lake, s) {
      return isAvg
        ? windrankLakeAvg(lake, s, months, tempRange, tempActive, useDaylight)
        : windrankLakeDays(lake, s, months, tempRange, tempActive,
            wmin, wmax, hourThreshold, useDaylight);
    }
    function tally(lake, s) {
      if (!s) { failed++; return; }
      const v = tallyValue(lake, s);
      if (v === null || v === undefined) failed++;
      else results.push({ lake, value: v });
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
      // Phase 1: Open-Meteo batch values. Batches that fail (usually
      // transient rate limiting) get one sequential retry pass before their
      // lakes are counted as failed.
      setWindRankStatus(`Fetching Open-Meteo hourly wind for ${costNote}…`);
      const retryBatches = [];
      async function processOmBatch(batch) {
        const series = await fetchBatchHourly(batch, start, omEnd, signal, tempActive);
        for (let k = 0; k < batch.length; k++) {
          const v = tallyValue(batch[k], series[k]);
          if (v === null || v === undefined) failed++;
          else omValues.set(batch[k], v);
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
      // Phase 2: Meteostat per-lake values, joined with phase 1. Lakes
      // missing the Open-Meteo value were already counted as failed.
      next = 0; processed = 0;
      setWindRankStatus(`Fetching Meteostat hourly wind for ${costNote}…`);
      async function msPhaseWorker() {
        while (next < lakes.length) {
          if (signal.aborted) return;
          const lake = lakes[next++];
          try {
            const s = await msFetchLakeHourly(lake.lat, lake.lon, start, msEnd, signal);
            const omV = omValues.get(lake);
            if (omV !== undefined) {
              const msV = s ? tallyValue(lake, s) : null;
              if (msV === null || msV === undefined) failed++;
              else results.push({ lake, om: omV, ms: msV });
            }
          } catch (err) {
            if (signal.aborted) return;
            if (omValues.get(lake) !== undefined) failed++;
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

    // Best first under the active criterion; ties broken by name for a stable
    // table. In compare mode the "Sort by" picker chooses which provider's
    // value leads; the Δ column shows the other provider's difference.
    const rankByMs = isCompare && $("windrank-rankby").value === "meteostat";
    results.sort((a, b) => {
      const av = isCompare ? (rankByMs ? a.ms : a.om) : a.value;
      const bv = isCompare ? (rankByMs ? b.ms : b.om) : b.value;
      if (isAvg) {
        const d = avgDir === "asc" ? av - bv : bv - av;
        return d || a.lake.name.localeCompare(b.lake.name);
      }
      return (bv - av) || a.lake.name.localeCompare(b.lake.name);
    });
    renderWindRankTable(results.slice(0, topN), scope === "all", isCompare, criteria);
    $("windrank-table-wrap").hidden = false;
    const notes = [];
    if (!isAvg) notes.push(`wind ${wmin}–${wmax} mph for ≥${hourThreshold} h/day`);
    notes.push(useDaylight ? "daylight hours only" : "all 24 hours");
    if (months.length < 12) notes.push(`months: ${months.map((m) => MONTH_ABBR[m - 1]).join(", ")}`);
    if (tempActive) notes.push(`daily mean temp ${tempRange.min ?? "…"}–${tempRange.max ?? "…"}°F`);
    if (areaExcluded) notes.push(`${areaExcluded.toLocaleString()} excluded by the area filter`);
    if (failed) notes.push(isCompare
      ? `${failed.toLocaleString()} had no usable data from one or both providers`
      : `${failed.toLocaleString()} had no usable data`);
    const rankDesc = isAvg
      ? `by average wind (${avgDir === "asc" ? "calmest" : "windiest"} first)`
      : "by matching days";
    const sortNote = isCompare
      ? ` (both providers; sorted by ${rankByMs ? "Meteostat" : "Open-Meteo"} ${isAvg ? "avg wind" : "days"}, Δ = Meteostat − Open-Meteo)`
      : ` (${provider === "meteostat" ? "Meteostat station interpolation" : "Open-Meteo archive"})`;
    setWindRankStatus(
      `Ranked ${results.length.toLocaleString()} lakes ${rankDesc}, ${start} to ${end}` +
      sortNote + " — " + notes.join("; ") + ".");
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

function renderWindRankTable(rows, showState, isCompare = false, criteria = "days") {
  const isAvg = criteria === "avg";
  const thead = document.querySelector("#windrank-table thead");
  const tbody = document.querySelector("#windrank-table tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";
  const cols = ["#", "Lake", "County"];
  if (showState) cols.push("State");
  cols.push("Area (acres)");
  if (isCompare) cols.push(...(isAvg ? ["OM wind (mph)", "MS wind (mph)", "Δ (mph)"] : ["OM days", "MS days", "Δ"]));
  else cols.push(isAvg ? "Avg wind (mph)" : "Days matching");
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
      const fmtV = (v) => (isAvg ? v.toFixed(1) : String(v));
      cells.push(fmtV(r.om), fmtV(r.ms));
      const d = r.ms - r.om;
      const mag = isAvg ? Math.abs(d).toFixed(1) : String(Math.abs(d));
      cells.push(`${d > 0 ? "+" : d < 0 ? "−" : ""}${mag}`);
    } else {
      cells.push(isAvg ? r.value.toFixed(1) : String(r.value));
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
    btn.addEventListener("click", () => loadRankedLake(r.lake));
    btnCell.appendChild(btn);
    tr.appendChild(btnCell);
    tbody.appendChild(tr);
  });
}

document.addEventListener("DOMContentLoaded", initWindRank);
