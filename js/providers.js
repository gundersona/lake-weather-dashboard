// Weather provider adapters. Each fetchWeather returns:
//   { time: [ISO strings], values: { param: [number|null, ...] } }
"use strict";

const OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const MIN_START = "1940-01-01";
const MAX_SPAN_DAYS = 366;

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

/** Earliest end date Open-Meteo's archive API supports (~5 days ago). */
function maxEndDate() {
  const d = new Date();
  d.setDate(d.getDate() - 5);
  return toISODate(d);
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

async function fetchOpenMeteo(lat, lon, start, end, params) {
  if (start < MIN_START) {
    throw new Error(`Start date must be on or after ${MIN_START} (archive data begins in 1940).`);
  }
  if (end > maxEndDate()) {
    throw new Error(`End date must be no later than ${maxEndDate()} (archive data lags ~5 days).`);
  }
  if (start > end) {
    throw new Error("Start date must be before the end date.");
  }
  if (daysBetween(start, end) > MAX_SPAN_DAYS) {
    throw new Error("Date range is limited to 366 days per request.");
  }

  const url =
    `${OPEN_METEO_ARCHIVE}?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}` +
    `&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}` +
    `&hourly=${encodeURIComponent(params.join(","))}&timezone=auto`;

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
  if (!data.hourly || !Array.isArray(data.hourly.time)) {
    throw new Error("Open-Meteo returned an unexpected response (no hourly data).");
  }
  const values = {};
  for (const p of params) {
    values[p] = Array.isArray(data.hourly[p]) ? data.hourly[p] : [];
  }
  return { time: data.hourly.time, values };
}

async function fetchMeteostat() {
  throw new Error(
    "Meteostat needs a server-side API key and isn't available in this static build — please use Open-Meteo."
  );
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
async function fetchWeather(provider, lat, lon, start, end, params) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown weather provider: ${provider}.`);
  return p.fetchWeather(lat, lon, start, end, params);
}
