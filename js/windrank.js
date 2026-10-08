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
  // The map stays visible in ranking mode — zoom to the picked lake like the
  // manual flow does, then point at the next step: Load weather fills the
  // graphs and data table below.
  selectLake(live, { zoom: true });
  refreshWindRankSelected();
  document.getElementById("load-btn").scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Mirror the selected lake into the ranking panel. The manual panel's
 * selected-lake line is hidden in ranking mode, so without this the Load
 * buttons give no visible confirmation of what was picked.
 */
function refreshWindRankSelected() {
  const el = $("windrank-selected");
  if (!el) return;
  const lake = typeof getSelectedLake === "function" ? getSelectedLake() : null;
  el.innerHTML = "";
  if (!lake) {
    el.textContent = "No lake selected.";
    return;
  }
  const strong = document.createElement("strong");
  strong.textContent = lake.name;
  el.appendChild(strong);
  el.appendChild(document.createTextNode(
    ` — ${lake.county || "unknown county"}, ${lake.state} (${lake.lat.toFixed(3)}, ${lake.lon.toFixed(3)})`
  ));
}

function initWindRank() {
  refreshWindRankScopeLabel();
  refreshRankByRow();
  refreshCriteriaUI();
  refreshSearchMode();
  $("provider").addEventListener("change", refreshRankByRow);
  $("windrank-criteria").addEventListener("change", refreshCriteriaUI);
  $("search-mode").addEventListener("change", refreshSearchMode);
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
 * Swap the lake-selection UI between manual selection (lake search + map)
 * and wind ranking, per the "Search lakes by" dropdown. When the map becomes
 * visible again it needs a size re-sync after being hidden.
 */
function refreshSearchMode() {
  const isRank = $("search-mode").value === "windrank";
  $("manual-box").hidden = isRank;
  $("windrank-box").hidden = !isRank;
  refreshWindRankSelected();
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
 * filtering. Each bucket: { winds: [mph|null], tSum, tN, tMin } over one UTC
 * day. Hours with no wind data are kept as null (they never count toward the
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
    if (!e) { e = { winds: [], tSum: 0, tN: 0, tMin: Infinity }; byDate.set(ymd, e); days.push(e); }
    e.winds.push(winds[i]);
    const t = temps ? temps[i] : null;
    if (t !== null && t !== undefined) { e.tSum += t; e.tN++; if (t < e.tMin) e.tMin = t; }
  }
  return days;
}

/**
 * Whole-day temperature filter: keep days whose daily temperature stat (mean
 * or minimum, per the "Temp filter applies to" control) is in range.
 */
function windrankDayPassesTemp(e, tempRange, tempActive, tempBasis) {
  if (!tempActive) return true;
  if (!e.tN) return false;
  const t = tempBasis === "min" ? e.tMin : e.tSum / e.tN;
  if (tempRange.min !== null && t < tempRange.min) return false;
  if (tempRange.max !== null && t > tempRange.max) return false;
  return true;
}

/**
 * Count the days in one lake's hourly series that match the criteria: at
 * least hourThreshold hours with wind inside [wmin, wmax], on a selected
 * month, with the daily temperature in range when the temp filter is active.
 * s is { time: [ISO], wind: [mph|null], temp: [F|null] }, UTC hourly.
 * Hours with no wind data never count toward the threshold.
 * Returns { match, eligible, monthDays }: days hitting the wind criterion,
 * days passing the month + temperature filters (the denominator for the %
 * column), and days passing the month filter with usable temp data (the
 * temp-filter denominator for the "removed" count).
 */
function windrankLakeDays(lake, s, months, tempRange, tempActive, tempBasis, wmin, wmax, hourThreshold, useDaylight) {
  let match = 0, eligible = 0, monthDays = 0;
  for (const e of windrankDayBuckets(lake, s, months, useDaylight)) {
    if (tempActive && !e.tN) continue;
    monthDays++;
    if (!windrankDayPassesTemp(e, tempRange, tempActive, tempBasis)) continue;
    eligible++;
    let qual = 0;
    for (const w of e.winds) {
      if (w !== null && w !== undefined && w >= wmin && w <= wmax) qual++;
    }
    if (qual >= hourThreshold) match++;
  }
  return { match, eligible, monthDays };
}

/**
 * Mean hourly wind (mph) over the days passing the shared filters, with the
 * count of eligible days. Same filtering as the day-count criterion, so both
 * rankings answer to all filters. Returns { avg, eligible, monthDays }.
 */
function windrankLakeAvg(lake, s, months, tempRange, tempActive, tempBasis, useDaylight) {
  let sum = 0, n = 0, eligible = 0, monthDays = 0;
  for (const e of windrankDayBuckets(lake, s, months, useDaylight)) {
    if (tempActive && !e.tN) continue;
    monthDays++;
    if (!windrankDayPassesTemp(e, tempRange, tempActive, tempBasis)) continue;
    eligible++;
    for (const w of e.winds) {
      if (w === null || w === undefined) continue;
      sum += w;
      n++;
    }
  }
  return { avg: n ? sum / n : null, eligible, monthDays };
}

async function runWindRank() {
  if (windrankRunning) return;
  refreshWindRankScopeLabel();
  refreshWindRankSelected();
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
  const tempBasis = getTempBasis();
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
    // Temp-filter verbosity: days removed per lake (month-filtered days with
    // temp data minus eligible days), summed over ranked lakes.
    let removedSum = 0, removedMin = Infinity, removedMax = 0;
    function noteTempRemoved(monthDays, eligible) {
      if (!tempActive) return;
      const removed = monthDays - eligible;
      removedSum += removed;
      if (removed < removedMin) removedMin = removed;
      if (removed > removedMax) removedMax = removed;
    }
    // Compare mode: phase 1 stores each lake's Open-Meteo value here for
    // phase 2 (Meteostat) to join against — one small record per lake, so
    // even the all-states scope stays light on memory.
    const omValues = new Map();
    /**
     * One lake's ranking result under the active criterion (value null when
     * unusable): { value, eligible, monthDays } — the value (match-day count
     * or mean wind), days passing the month + temperature filters, and days
     * passing the month filter with usable temp data.
     */
    function tallyValue(lake, s) {
      const r = isAvg
        ? windrankLakeAvg(lake, s, months, tempRange, tempActive, tempBasis, useDaylight)
        : windrankLakeDays(lake, s, months, tempRange, tempActive, tempBasis,
            wmin, wmax, hourThreshold, useDaylight);
      const value = isAvg ? r.avg : r.match;
      return { value, eligible: r.eligible, monthDays: r.monthDays };
    }
    function tally(lake, s) {
      if (!s) { failed++; return; }
      const t = tallyValue(lake, s);
      if (t.value === null || t.value === undefined) { failed++; return; }
      results.push({ lake, value: t.value, eligible: t.eligible, monthDays: t.monthDays });
      noteTempRemoved(t.monthDays, t.eligible);
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
          const t = tallyValue(batch[k], series[k]);
          if (t.value === null || t.value === undefined) failed++;
          else omValues.set(batch[k], t);
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
              const t = s ? tallyValue(lake, s) : { value: null };
              if (t.value === null || t.value === undefined) failed++;
              else {
                results.push({ lake, om: omV, ms: t });
                noteTempRemoved(t.monthDays, t.eligible);
              }
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
      const av = isCompare ? (rankByMs ? a.ms.value : a.om.value) : a.value;
      const bv = isCompare ? (rankByMs ? b.ms.value : b.om.value) : b.value;
      if (isAvg) {
        const d = avgDir === "asc" ? av - bv : bv - av;
        return d || a.lake.name.localeCompare(b.lake.name);
      }
      return (bv - av) || a.lake.name.localeCompare(b.lake.name);
    });
    renderWindRankTable(results.slice(0, topN), scope === "all", isCompare, criteria, days);
    $("windrank-table-wrap").hidden = false;
    const notes = [];
    if (!isAvg) notes.push(`wind ${wmin}–${wmax} mph for ≥${hourThreshold} h/day`);
    notes.push(useDaylight ? "daylight hours only" : "all 24 hours");
    if (months.length < 12) notes.push(`months: ${months.map((m) => MONTH_ABBR[m - 1]).join(", ")}`);
    if (tempActive) {
      notes.push(`temp ${tempRange.min ?? "…"}–${tempRange.max ?? "…"}°F (${tempBasisLabel()})`);
      if (results.length && removedMin !== Infinity) {
        const avgRemoved = removedSum / results.length;
        notes.push(`temp filter removed ${avgRemoved.toFixed(1)} days/lake on average (range ${removedMin}–${removedMax})`);
      }
    }
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

function renderWindRankTable(rows, showState, isCompare = false, criteria = "days", totalDays = 0) {
  const isAvg = criteria === "avg";
  const thead = document.querySelector("#windrank-table thead");
  const tbody = document.querySelector("#windrank-table tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";
  /** "5 (71%)" — count with its share of temp+month-eligible days. */
  const daysCell = (v, elig) =>
    elig > 0 ? `${v} (${Math.round((v / elig) * 100)}%)` : String(v);
  /** "23 (74%)" — eligible days with their share of the selected range. */
  const eligCell = (elig) =>
    totalDays > 0 ? `${elig} (${Math.round((elig / totalDays) * 100)}%)` : String(elig);
  const cols = ["#", "Lake", "County"];
  if (showState) cols.push("State");
  cols.push("Area (acres)");
  if (isCompare) {
    if (isAvg) {
      cols.push("OM wind (mph)", "MS wind (mph)", "\u0394 (mph)", "Eligible days (OM/MS)");
    } else {
      cols.push("OM days", "MS days", "\u0394");
    }
  } else {
    cols.push(isAvg ? "Avg wind (mph)" : "Days matching");
    cols.push(isAvg ? "Eligible days" : "% of eligible");
  }
  cols.push("");
  const headRow = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c;
    if (c === "Days matching" || c === "OM days" || c === "MS days") {
      th.title = "Matching days (share of days passing the month and temperature filters)";
    } else if (c === "% of eligible") {
      th.title = "Matching days divided by days passing the month and temperature filters";
    } else if (c === "Eligible days" || c === "Eligible days (OM/MS)") {
      th.title = "Days passing the month and temperature filters (share of days in the selected range)";
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    const cells = [String(i + 1), r.lake.name, r.lake.county || "—"];
    if (showState) cells.push(r.lake.state);
    cells.push(formatAcres(r.lake.area_km2));
    if (isCompare) {
      if (isAvg) {
        const d = r.ms.value - r.om.value;
        const mag = Math.abs(d).toFixed(1);
        cells.push(r.om.value.toFixed(1), r.ms.value.toFixed(1),
          `${d > 0 ? "+" : d < 0 ? "−" : ""}${mag}`,
          `${eligCell(r.om.eligible)} / ${eligCell(r.ms.eligible)}`);
      } else {
        cells.push(daysCell(r.om.value, r.om.eligible), daysCell(r.ms.value, r.ms.eligible));
        const d = r.ms.value - r.om.value;
        cells.push(`${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d)}`);
      }
    } else if (isAvg) {
      cells.push(r.value.toFixed(1), eligCell(r.eligible));
    } else {
      cells.push(String(r.value), daysCell(r.value, r.eligible));
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
  });
}

document.addEventListener("DOMContentLoaded", initWindRank);
