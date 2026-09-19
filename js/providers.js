// Weather provider adapters. Each fetchWeather returns:
//   { time: [ISO strings], values: { param: [number|null, ...] } }
"use strict";

const OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const MIN_START = "1940-01-01";
const HOURLY_MAX_SPAN_DAYS = 366;

/** Canonical hourly param -> Open-Meteo daily params (for daily/monthly aggregation). */
const DAILY_MAP = {
  temperature_2m: ["temperature_2m_max", "temperature_2m_min", "temperature_2m_mean"],
  precipitation: ["precipitation_sum"],
  wind_speed_10m: ["wind_speed_10m_max", "wind_speed_10m_mean"],
  wind_direction_10m: ["wind_direction_10m_dominant"],
};
/** Params with no Open-Meteo daily equivalent (hourly aggregation only). */
const HOURLY_ONLY_PARAMS = ["relative_humidity_2m", "surface_pressure"];

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

/** Earliest end date the archive can serve — provider and aggregation aware. */
function maxEndDate(provider, aggregation) {
  const d = new Date();
  if (provider === "meteostat") {
    // Meteostat hourly is near real-time; daily bulk lags ~2 days.
    d.setDate(d.getDate() - (aggregation === "hourly" ? 0 : 2));
  } else {
    d.setDate(d.getDate() - 5); // Open-Meteo's archive lags ~5 days
  }
  return toISODate(d);
}

/** ISO date n years ago today (handles leap years). */
function yearsAgoISO(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return toISODate(d);
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

const OPEN_METEO_UNITS = {
  temperature_unit: "fahrenheit",
  precipitation_unit: "inch",
  wind_speed_unit: "mph",
};

function buildUrl(base, query) {
  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${base}?${qs}`;
}

async function fetchJson(url, what) {
  const resp = await fetch(url);
  if (!resp.ok) {
    let detail = "";
    try {
      const body = await resp.json();
      if (body && body.reason) detail = ` — ${body.reason}`;
    } catch (_) { /* ignore */ }
    throw new Error(`Open-Meteo request failed (HTTP ${resp.status})${detail}.`);
  }
  const data = await resp.json();
  if (!data[what] || !Array.isArray(data[what].time)) {
    throw new Error(`Open-Meteo returned an unexpected response (no ${what} data).`);
  }
  return data[what];
}

async function fetchHourly(lat, lon, start, end, params) {
  const url = buildUrl(OPEN_METEO_ARCHIVE, {
    ...OPEN_METEO_UNITS,
    latitude: lat,
    longitude: lon,
    start_date: start,
    end_date: end,
    hourly: params.join(","),
    timezone: "auto",
  });
  const hourly = await fetchJson(url, "hourly");
  const values = {};
  for (const p of params) {
    values[p] = Array.isArray(hourly[p]) ? hourly[p] : [];
  }
  return { time: hourly.time, values, resolution: "hourly" };
}

async function fetchDaily(lat, lon, start, end, params) {
  const unsupported = params.filter((p) => HOURLY_ONLY_PARAMS.includes(p));
  if (unsupported.length) {
    throw new Error(
      "Humidity and pressure are only available with hourly aggregation (past year). " +
      "Uncheck them or switch the aggregation to hourly."
    );
  }
  const dailyParams = [...new Set(params.flatMap((p) => DAILY_MAP[p] || []))];
  if (!dailyParams.length) {
    throw new Error("None of the selected variables are available for daily/monthly aggregation.");
  }
  const url = buildUrl(OPEN_METEO_ARCHIVE, {
    ...OPEN_METEO_UNITS,
    latitude: lat,
    longitude: lon,
    start_date: start,
    end_date: end,
    daily: dailyParams.join(","),
    timezone: "auto", // required when daily variables are requested
  });
  const daily = await fetchJson(url, "daily");
  const n = daily.time.length;
  const col = (name) => (Array.isArray(daily[name]) ? daily[name] : new Array(n).fill(null));

  const values = {};
  if (params.includes("temperature_2m")) {
    // True daily mean straight from the API (not the (max+min)/2 approximation).
    values["temperature_2m"] = col("temperature_2m_mean");
    values["temperature_2m_max"] = col("temperature_2m_max");
    values["temperature_2m_min"] = col("temperature_2m_min");
  }
  if (params.includes("precipitation")) values["precipitation"] = col("precipitation_sum");
  if (params.includes("wind_speed_10m")) {
    values["wind_speed_10m"] = col("wind_speed_10m_mean");
    values["wind_speed_10m_max"] = col("wind_speed_10m_max");
  }
  if (params.includes("wind_direction_10m")) values["wind_direction_10m"] = col("wind_direction_10m_dominant");
  return { time: daily.time, values, resolution: "daily" };
}

async function fetchOpenMeteo(lat, lon, start, end, params, aggregation = "hourly") {
  if (!["hourly", "daily", "monthly"].includes(aggregation)) {
    throw new Error(`Unknown aggregation: ${aggregation}.`);
  }
  if (start < MIN_START) {
    throw new Error(`From date must be on or after ${MIN_START} (archive data begins in 1940).`);
  }
  const maxEnd = maxEndDate();
  if (end > maxEnd) {
    throw new Error(`To date must be no later than ${maxEnd} (archive data lags ~5 days).`);
  }
  if (start > end) {
    throw new Error("From date must be before the To date.");
  }

  if (aggregation === "hourly") {
    if (start < yearsAgoISO(1) || daysBetween(start, end) > HOURLY_MAX_SPAN_DAYS) {
      throw new Error("Hourly data is available for the past year only (max 366 days).");
    }
    return fetchHourly(lat, lon, start, end, params);
  }
  if (aggregation === "daily") {
    if (start < yearsAgoISO(20)) {
      throw new Error("Daily data is available for the past 20 years only.");
    }
    return fetchDaily(lat, lon, start, end, params);
  }
  // monthly: full archive back to 1940, fetched as daily values and bucketed client-side
  return fetchDaily(lat, lon, start, end, params);
}

async function fetchMeteostat(lat, lon, start, end, params, aggregation = "hourly") {
  if (!["hourly", "daily", "monthly"].includes(aggregation)) {
    throw new Error(`Unknown aggregation: ${aggregation}.`);
  }
  if (start < MIN_START) {
    throw new Error(`From date must be on or after ${MIN_START} (Meteostat data begins in 1940).`);
  }
  const maxEnd = maxEndDate("meteostat", aggregation);
  if (end > maxEnd) {
    throw new Error(`To date must be no later than ${maxEnd} (Meteostat data lags ~${aggregation === "hourly" ? "1 day" : "2 days"}).`);
  }
  if (start > end) {
    throw new Error("From date must be before the To date.");
  }
  // Monthly wind would need the hourly bulk for all years (wind direction
  // isn't in the daily files) — cost-prohibitive, so it's skipped and the
  // UI says so. Everything else comes from the daily bulk files.
  let effParams = params;
  if (aggregation === "monthly") {
    effParams = params.filter((p) => p !== "wind_speed_10m" && p !== "wind_direction_10m");
  }
  // Monthly is served as daily series (resolution "daily") and bucketed by
  // the app, exactly like the Open-Meteo path — so the shared month/temp
  // filters and the min/max series handling work identically.
  const data = await msFetchWeather(lat, lon, start, end, effParams, aggregation === "monthly" ? "daily" : aggregation);
  // In hourly mode wind_speed_10m_max isn't set (no true maxima).
  if (aggregation === "hourly") delete data.values["wind_speed_10m_max"];
  return data;
}

/**
 * Provider registry. To add Meteostat (or another provider) later,
 * add an entry: name -> async (lat, lon, start, end, params) => {time, values}.
 */
const PROVIDERS = {
  "open-meteo": { label: "Open-Meteo", fetchWeather: fetchOpenMeteo },
  "meteostat": { label: "Meteostat", fetchWeather: fetchMeteostat },
};

/** Unified entry point used by the app. */
async function fetchWeather(provider, lat, lon, start, end, params, aggregation = "hourly") {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown weather provider: ${provider}.`);
  return p.fetchWeather(lat, lon, start, end, params, aggregation);
}
