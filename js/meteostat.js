// Meteostat keyless bulk-data client for the dashboard.
//
// A plain-JS port of the meteostat Python library's (2.1.5) interpolate()
// path, reading the same keyless bulk CSVs (CC BY 4.0) the library uses:
//
//   https://data.meteostat.net/{hourly|daily}/{year}/{station}.csv.gz
//
// Faithful to the library's defaults:
//   - station search: the closest stations within 50 km, up to 4
//     (the library's nearby() does not filter by inventory — neither do we;
//     a station whose file 404s is simply skipped)
//   - effective distance: sqrt(dist^2 + (elevDiff * 10)^2). Our lakes have no
//     elevation, so this reduces to plain distance — exactly what the library
//     does for a Point without elevation. The lapse-rate correction is
//     likewise inert without a point elevation.
//   - nearest-neighbor values win when the closest station is within 5000 m,
//     combined with IDW (power 2) so gaps still get filled
//     (the library's combine_first(nearest, idw) behavior)
//   - categorical parameters (wind direction) always come from the nearest
//     station, never IDW
//   - values rounded to 1 decimal
//
// Dashboard mapping (bulk value -> dashboard variable, converted to the
// dashboard's imperial units):
//   temp -> temperature_2m (C -> F); daily adds tmin/tmax
//   rhum -> relative_humidity_2m (%)
//   pres -> surface_pressure (hPa)
//   prcp -> precipitation (mm -> in)
//   wspd -> wind_speed_10m (km/h -> mph)
//   wdir -> wind_direction_10m (deg)
//
// All times are UTC (the bulk files are UTC). Daily and monthly aggregations
// derive daily values from the daily bulk files, except wind direction, which
// the daily bulk doesn't carry — it is derived from the hourly bulk instead
// (circular mean of the day's interpolated hourly directions).
"use strict";

const MS_BASE = "https://data.meteostat.net";
const MS_STATION_FILE = "data/meteostat/stations.json?v=2";
const MS_LIMIT = 4;          // stations per point (library: nearby(..., 4))
const MS_RADIUS_M = 50000;   // library nearby() default radius
const MS_NEAREST_M = 5000;   // library distance_threshold
const MS_POWER = 2;          // library IDW power
const MS_CACHE_MAX = 4000;   // parsed station-year files kept (LRU)

/** Bulk columns parsed per product (subset of each file's columns). */
const MS_COLUMNS = {
  hourly: ["temp", "rhum", "prcp", "wdir", "wspd", "wpgt", "pres"],
  daily: ["temp", "tmin", "tmax", "rhum", "prcp", "wspd", "wpgt", "pres"],
};

/**
 * Interpolation specs: bulk column -> dashboard key.
 * `categorical` mirrors the library's CATEGORICAL_PARAMETERS for our params.
 * `dailyExtra` marks series the app expects alongside the daily mean
 * (temperature_2m_max/min); wind_speed_10m_max is filled separately.
 */
const MS_HOURLY_SPECS = [
  { bulk: "temp", key: "temperature_2m", convert: msCtoF },
  { bulk: "rhum", key: "relative_humidity_2m", convert: (v) => v },
  { bulk: "pres", key: "surface_pressure", convert: (v) => v },
  { bulk: "prcp", key: "precipitation", convert: msMmToIn },
  { bulk: "wspd", key: "wind_speed_10m", convert: msKmhToMph },
  { bulk: "wpgt", key: "wind_gusts_10m", convert: msKmhToMph },
  { bulk: "wdir", key: "wind_direction_10m", convert: (v) => v, categorical: true },
];
const MS_DAILY_SPECS = [
  { bulk: "temp", key: "temperature_2m", convert: msCtoF },
  { bulk: "tmin", key: "temperature_2m_min", convert: msCtoF, dailyExtra: true },
  { bulk: "tmax", key: "temperature_2m_max", convert: msCtoF, dailyExtra: true },
  { bulk: "rhum", key: "relative_humidity_2m", convert: (v) => v },
  { bulk: "pres", key: "surface_pressure", convert: (v) => v },
  { bulk: "prcp", key: "precipitation", convert: msMmToIn },
  { bulk: "wspd", key: "wind_speed_10m", convert: msKmhToMph },
  { bulk: "wpgt", key: "wind_gusts_10m", convert: msKmhToMph },
];

// ---------------------------------------------------------------- units

function msCtoF(c) { return (c * 9) / 5 + 32; }
function msMmToIn(mm) { return mm / 25.4; }
function msKmhToMph(kmh) { return kmh * 0.621371; }
function msR1(v) {
  return v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10) / 10;
}

/** Circular mean of compass degrees (0-360), or null. */
function msCircularMean(degrees) {
  let sx = 0, sy = 0, n = 0;
  for (const d of degrees) {
    if (d === null || d === undefined || Number.isNaN(d)) continue;
    const r = (d * Math.PI) / 180;
    sx += Math.cos(r); sy += Math.sin(r); n++;
  }
  if (!n) return null;
  let deg = (Math.atan2(sy, sx) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

// ---------------------------------------------------------------- station directory

let msDirPromise = null;
let msGrid = null; // "floor(lat),floor(lon)" -> array of directory indices

async function msDirectory() {
  if (!msDirPromise) {
    msDirPromise = (async () => {
      const resp = await fetch(MS_STATION_FILE);
      if (!resp.ok) throw new Error(`Station directory unavailable (HTTP ${resp.status}).`);
      const raw = await resp.json(); // [[id, lat, lon, elev, name], ...]
      const dir = raw.map((r) => ({ id: r[0], lat: r[1], lon: r[2], elev: r[3], name: r[4] || r[0] }));
      msGrid = new Map();
      dir.forEach((s, i) => {
        const key = Math.floor(s.lat) + "," + Math.floor(s.lon);
        let cell = msGrid.get(key);
        if (!cell) { cell = []; msGrid.set(key, cell); }
        cell.push(i);
      });
      return dir;
    })();
  }
  return msDirPromise;
}

function msHaversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLa = ((lat2 - lat1) * Math.PI) / 180;
  const dLo = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLa / 2) * Math.sin(dLa / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Closest stations within radiusM of (lat, lon), sorted by distance.
 * Uses a 1-degree grid so per-lake lookup stays cheap at analysis scale.
 */
async function msNearby(lat, lon, limit = MS_LIMIT, radiusM = MS_RADIUS_M) {
  const dir = await msDirectory();
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * (Math.cos((lat * Math.PI) / 180) || 0.01));
  const cands = [];
  const seen = new Set();
  for (let la = Math.floor(lat - dLat); la <= Math.floor(lat + dLat); la++) {
    for (let lo = Math.floor(lon - dLon); lo <= Math.floor(lon + dLon); lo++) {
      const cell = msGrid.get(la + "," + lo);
      if (!cell) continue;
      for (const i of cell) {
        if (seen.has(i)) continue;
        seen.add(i);
        const s = dir[i];
        const d = msHaversineM(lat, lon, s.lat, s.lon);
        if (d <= radiusM) cands.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, dist: d });
      }
    }
  }
  cands.sort((a, b) => a.dist - b.dist);
  return cands.slice(0, limit);
}

// ---------------------------------------------------------------- bulk CSV fetching (shared LRU cache)

const msCsvCache = new Map(); // key -> Promise<Map<string, object>|null>

function msCacheGet(key) {
  const p = msCsvCache.get(key);
  if (p !== undefined) {
    // refresh LRU position
    msCsvCache.delete(key);
    msCsvCache.set(key, p);
  }
  return p;
}

function msCacheSet(key, promise) {
  const guarded = promise.catch((err) => {
    // A failed fetch must not poison the cache — a retry can refetch.
    if (msCsvCache.get(key) === guarded) msCsvCache.delete(key);
    throw err;
  });
  msCsvCache.set(key, guarded);
  while (msCsvCache.size > MS_CACHE_MAX) {
    msCsvCache.delete(msCsvCache.keys().next().value);
  }
  return guarded;
}

async function msGunzip(buf) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser can't decompress Meteostat's data files (DecompressionStream is unavailable).");
  }
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function msParseCsv(product, text, columns) {
  const lines = text.trim().split("\n");
  const rows = new Map();
  if (lines.length < 2) return rows;
  const head = lines[0].split(",");
  const idx = {};
  head.forEach((h, i) => { idx[h] = i; });
  const needHour = product === "hourly";
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (c.length < head.length) continue;
    const key = needHour
      ? `${c[idx.year]}-${c[idx.month].padStart(2, "0")}-${c[idx.day].padStart(2, "0")}` +
        `T${c[idx.hour].padStart(2, "0")}:00:00`
      : `${c[idx.year]}-${c[idx.month].padStart(2, "0")}-${c[idx.day].padStart(2, "0")}`;
    const row = {};
    for (const col of columns) {
      const v = idx[col] === undefined ? "" : c[idx[col]];
      row[col] = v === undefined || v === "" ? null : parseFloat(v);
    }
    rows.set(key, row);
  }
  return rows;
}

/**
 * Fetch one station-year bulk file. Resolves to a Map of time-string ->
 * row (all parsed columns for the product), or null when the file doesn't
 * exist (404). Results (including 404s) are cached; transient network
 * errors are not. Columns are fixed per product so the cache key never
 * collides across callers needing different subsets.
 */
async function msFetchStationYear(product, stationId, year, signal) {
  const key = `${product}/${year}/${stationId}`;
  const hit = msCacheGet(key);
  if (hit) return hit;
  return msCacheSet(key, (async () => {
    const url = `${MS_BASE}/${product}/${year}/${stationId}.csv.gz`;
    let resp;
    try {
      resp = await fetch(url, signal ? { signal } : undefined);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      msCsvCache.delete(key); // transient — don't cache the miss
      return null;
    }
    if (resp.status === 404) return null;
    if (!resp.ok) {
      msCsvCache.delete(key);
      throw new Error(`Meteostat ${product} data for ${stationId} (${year}) failed: HTTP ${resp.status}.`);
    }
    const text = await msGunzip(await resp.arrayBuffer());
    return msParseCsv(product, text, MS_COLUMNS[product]);
  })());
}

/** Fetch every station-year in the cartesian product; stationId -> merged Map|null. */
async function msLoadMany(product, stations, years, signal, onFileDone) {
  const data = new Map();
  // Bounded concurrency: a 30-year hourly pull is up to 120 small files;
  // fetch a few at a time instead of firing them all at once.
  const MAX_CONCURRENT_FILES = 8;
  const queue = [];
  for (const st of stations) for (const y of years) queue.push([st, y]);
  const perStation = new Map(stations.map((st) => [st.id, []]));
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const [st, y] = queue[next++];
      const m = await msFetchStationYear(product, st.id, y, signal).then((mm) => {
        if (onFileDone) onFileDone();
        return mm;
      });
      perStation.get(st.id).push(m);
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_FILES, queue.length) }, worker));
  for (const st of stations) {
    const merged = new Map();
    for (const m of perStation.get(st.id)) {
      if (m) for (const [k, v] of m) merged.set(k, v);
    }
    data.set(st.id, merged.size ? merged : null);
  }
  return data;
}

// ---------------------------------------------------------------- interpolation

/**
 * Spatial interpolation over one time grid, mirroring the library:
 * nearest-neighbor wins within 5000 m (falling back to IDW for gaps),
 * otherwise pure IDW; categorical params always take the nearest station.
 *
 * stations: [{id, dist}] sorted by dist. getRows(id) -> Map|null.
 * specs: [{bulk, categorical}]. Returns [{bulk: value|null, ...}] per time.
 */
function msInterpolate(times, stations, getRows, specs) {
  const useNearest = stations.length > 0 && stations[0].dist <= MS_NEAREST_M;
  return times.map((t) => {
    const out = {};
    for (const spec of specs) {
      const vals = [];
      for (const st of stations) {
        const rows = getRows(st.id);
        if (!rows) continue;
        const r = rows.get(t);
        const v = r ? r[spec.bulk] : null;
        if (v !== null && v !== undefined && !Number.isNaN(v)) vals.push({ v, st });
      }
      if (!vals.length) { out[spec.bulk] = null; continue; }
      if (spec.categorical) {
        let best = vals[0];
        for (const x of vals) if (x.st.dist < best.st.dist) best = x;
        out[spec.bulk] = best.v;
        continue;
      }
      let result = null;
      if (useNearest) {
        let best = null;
        for (const x of vals) {
          if (x.st.dist <= MS_NEAREST_M && (!best || x.st.dist < best.st.dist)) best = x;
        }
        if (best) result = best.v;
      }
      if (result === null) {
        let wsum = 0, vsum = 0, exact = false;
        for (const x of vals) {
          const d = x.st.dist; // == effective distance (no point elevation)
          if (d === 0) { result = x.v; exact = true; break; }
          const w = 1 / Math.pow(d, MS_POWER);
          wsum += w;
          vsum += w * x.v;
        }
        if (!exact) result = wsum > 0 ? vsum / wsum : null;
      }
      out[spec.bulk] = result;
    }
    return out;
  });
}

// ---------------------------------------------------------------- time grids

function msDailyTimes(start, end) {
  const out = [];
  const d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function msHourlyTimes(start, end) {
  const out = [];
  const d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  for (const day = new Date(d); day <= e; day.setUTCDate(day.getUTCDate() + 1)) {
    const ymd = day.toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      out.push(`${ymd}T${String(h).padStart(2, "0")}:00:00`);
    }
  }
  return out;
}

function msYears(start, end) {
  const ys = [];
  for (let y = parseInt(start.slice(0, 4), 10); y <= parseInt(end.slice(0, 4), 10); y++) ys.push(y);
  return ys;
}

// ---------------------------------------------------------------- public API

function msAssertHasData(values) {
  for (const k of Object.keys(values)) {
    if (values[k].some((v) => v !== null && v !== undefined)) return;
  }
  throw new Error("No Meteostat data available for this location and date range.");
}

/**
 * Main entry point for the weather view. Returns
 * { time: [ISO strings], values: {dashboardKey: [...]}, resolution }.
 * params are dashboard variable keys; aggregation is hourly|daily|monthly
 * (monthly is served from the daily bulk files, bucketed client-side).
 */
async function msFetchWeather(lat, lon, start, end, params, aggregation, signal, onProgress) {
  const stations = await msNearby(lat, lon);
  if (!stations.length) {
    throw new Error("No Meteostat stations within 50 km of this location.");
  }
  const years = msYears(start, end);
  const getRows = (data) => (id) => data.get(id);
  // Progress across the bulk files this fetch will download (≤4 stations ×
  // years × products). onProgress(done, total) lets the UI show a real bar.
  let doneFiles = 0;
  let totalFiles = 0;
  const tick = () => {
    doneFiles++;
    if (onProgress) onProgress(doneFiles, totalFiles);
  };

  if (aggregation === "hourly") {
    const times = msHourlyTimes(start, end);
    const specs = MS_HOURLY_SPECS.filter((s) => params.includes(s.key));
    totalFiles = stations.length * years.length;
    const data = await msLoadMany("hourly", stations, years, signal, tick);
    const rows = msInterpolate(times, stations, getRows(data), specs);
    const values = {};
    for (const s of specs) {
      values[s.key] = rows.map((r) => msR1(r[s.bulk] === null ? null : s.convert(r[s.bulk])));
    }
    msAssertHasData(values);
    return { time: times, values, resolution: "hourly", stations };
  }

  // daily / monthly: daily bulk for everything except wind direction, which
  // the daily bulk doesn't carry — derive it from the hourly bulk instead.
  const times = msDailyTimes(start, end);
  const specs = MS_DAILY_SPECS.filter(
    (s) => params.includes(s.key) || (s.dailyExtra && params.includes("temperature_2m"))
  );
  const needHourlyBulk = params.includes("wind_direction_10m") || params.includes("wind_speed_10m");
  totalFiles = stations.length * years.length * (needHourlyBulk ? 2 : 1);
  const data = await msLoadMany("daily", stations, years, signal, tick);
  const rows = msInterpolate(times, stations, getRows(data), specs);

  let wdirByDay = null;
  let wspdMaxByDay = null;
  // The daily bulk carries no wind direction, and daily wind_speed_10m_max
  // wants the true maxima — both need the hourly bulk.
  if (params.includes("wind_direction_10m") || params.includes("wind_speed_10m")) {
    const hTimes = msHourlyTimes(start, end);
    const hData = await msLoadMany("hourly", stations, years, signal, tick);
    const hRows = msInterpolate(hTimes, stations, getRows(hData), [
      { bulk: "wdir", categorical: true },
      { bulk: "wspd" },
    ]);
    wdirByDay = {};
    wspdMaxByDay = {};
    const perDay = new Map();
    hTimes.forEach((t, i) => {
      const dk = t.slice(0, 10);
      let e = perDay.get(dk);
      if (!e) { e = { wdirs: [], wspds: [] }; perDay.set(dk, e); }
      const r = hRows[i];
      if (r.wdir !== null) e.wdirs.push(r.wdir);
      if (r.wspd !== null) e.wspds.push(r.wspd);
    });
    for (const [dk, e] of perDay) {
      wdirByDay[dk] = e.wdirs.length ? msCircularMean(e.wdirs) : null;
      wspdMaxByDay[dk] = e.wspds.length ? Math.max(...e.wspds) : null;
    }
  }

  const values = {};
  for (const s of specs) {
    if (s.dailyExtra && !params.includes("temperature_2m")) continue;
    if (params.includes(s.key) || (s.dailyExtra && params.includes("temperature_2m"))) {
      values[s.key] = rows.map((r) => msR1(r[s.bulk] === null ? null : s.convert(r[s.bulk])));
    }
  }
  // wind_speed_10m_max: true daily maxima when the hourly bulk was fetched,
  // otherwise the max of the daily means.
  if (params.includes("wind_speed_10m")) {
    values["wind_speed_10m_max"] = wspdMaxByDay
      ? times.map((t) => msR1(wspdMaxByDay[t] === null ? null : msKmhToMph(wspdMaxByDay[t])))
      : values["wind_speed_10m"].slice();
  }
  if (params.includes("wind_direction_10m")) {
    values["wind_direction_10m"] = times.map((t) => msR1(wdirByDay[t]));
  }
  msAssertHasData(values);
  return { time: times, values, resolution: "daily", stations };
}

/**
 * Minimal daily wind + temperature for lake ranking. Returns
 * { time, wind: [mph|null], temp: [F|null] } or null when unusable.
 */
async function msFetchLakeDaily(lat, lon, start, end, signal) {
  const stations = await msNearby(lat, lon);
  if (!stations.length) return null;
  const years = msYears(start, end);
  const data = await msLoadMany("daily", stations, years, signal);
  const times = msDailyTimes(start, end);
  const rows = msInterpolate(times, stations, (id) => data.get(id), [{ bulk: "temp" }, { bulk: "wspd" }]);
  let anyWind = false;
  const wind = rows.map((r) => {
    const v = r.wspd === null ? null : msR1(msKmhToMph(r.wspd));
    if (v !== null) anyWind = true;
    return v;
  });
  if (!anyWind) return null;
  const temp = rows.map((r) => (r.temp === null ? null : msR1(msCtoF(r.temp))));
  return { time: times, wind, temp };
}

/**
 * Minimal hourly wind + temperature for the wind-day ranking. Returns
 * { time, wind: [mph|null], temp: [F|null] } or null when unusable.
 * Times are UTC ("YYYY-MM-DDTHH:00:00"), like the bulk files.
 */
async function msFetchLakeHourly(lat, lon, start, end, signal) {
  const stations = await msNearby(lat, lon);
  if (!stations.length) return null;
  const years = msYears(start, end);
  const data = await msLoadMany("hourly", stations, years, signal);
  const times = msHourlyTimes(start, end);
  const rows = msInterpolate(times, stations, (id) => data.get(id), [{ bulk: "temp" }, { bulk: "wspd" }]);
  let anyWind = false;
  const wind = rows.map((r) => {
    const v = r.wspd === null ? null : msR1(msKmhToMph(r.wspd));
    if (v !== null) anyWind = true;
    return v;
  });
  if (!anyWind) return null;
  const temp = rows.map((r) => (r.temp === null ? null : msR1(msCtoF(r.temp))));
  return { time: times, wind, temp };
}
