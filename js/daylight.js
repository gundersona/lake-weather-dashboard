// Daylight filtering: keep only hourly observations between sunrise and
// sunset, computed from latitude/longitude with the standard NOAA solar
// equations (zenith 90.833° = official sunrise/sunset). Applied to hourly
// series before any downstream reporting (summary, charts, wind rose,
// tables, CSV), so every number the user sees is daylight-only.
"use strict";

const DAYLIGHT_RAD = Math.PI / 180;

/** Day of year (1–366) for a UTC calendar date. */
function daylightDayOfYear(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / 86400000);
}

/**
 * UTC millisecond timestamp of sunrise (isSunrise=true) or sunset for one
 * UTC calendar date at lat/lon, via the NOAA sunrise/sunset algorithm.
 * Returns { ms } or { polarDay: true } / { polarNight: true } when the sun
 * never sets / never rises that day.
 */
function sunEventUTC(lat, lon, year, month, day, isSunrise) {
  const N = daylightDayOfYear(year, month, day);
  const lngHour = lon / 15;
  const t = N + ((isSunrise ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  let L = M + 1.916 * Math.sin(DAYLIGHT_RAD * M)
    + 0.020 * Math.sin(DAYLIGHT_RAD * 2 * M) + 282.634;
  L = ((L % 360) + 360) % 360;
  let RA = Math.atan(0.91764 * Math.tan(DAYLIGHT_RAD * L)) / DAYLIGHT_RAD;
  RA = ((RA % 360) + 360) % 360;
  const Lquad = Math.floor(L / 90) * 90;
  const RAquad = Math.floor(RA / 90) * 90;
  RA = (RA + (Lquad - RAquad)) / 15; // hours
  const sinDec = 0.39782 * Math.sin(DAYLIGHT_RAD * L);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(DAYLIGHT_RAD * 90.833) - sinDec * Math.sin(DAYLIGHT_RAD * lat))
    / (cosDec * Math.cos(DAYLIGHT_RAD * lat));
  if (cosH > 1) return { polarNight: true };  // sun never rises
  if (cosH < -1) return { polarDay: true };   // sun never sets
  let H = Math.acos(cosH) / DAYLIGHT_RAD;
  if (isSunrise) H = 360 - H;
  H /= 15;
  const T = H + RA - 0.06571 * t - 6.622;
  // Normalized to [0, 24) on the given UTC date. This can be off the true
  // absolute instant by a whole day for far-from-Greenwich longitudes; the
  // caller (isDaylight) resolves that with ±24h-shifted candidates.
  const UT = (((T - lngHour) % 24) + 24) % 24;
  return { ms: Date.UTC(year, month - 1, day) + UT * 3600000 };
}

/**
 * Drop nighttime hours from a provider dataset ({ time, values, ... }).
 * Keeps hours with sunrise <= t < sunset (the hour's timestamp marks the
 * start of the hour). utcOffsetSeconds converts local wall-clock timestamps
 * (single-provider Open-Meteo mode) to UTC instants; pass null/undefined
 * when timestamps are already UTC (Meteostat, compare mode).
 * Returns a dataset of the same shape with only daylight indices kept —
 * extra fields (stations, resolution, utcOffsetSeconds) are preserved.
 */
function filterDaylight(data, lat, lon, utcOffsetSeconds) {
  const n = data.time.length;
  const sun = new Map(); // "YYYY-MM-DD" (UTC) -> { riseMs, setMs, polarDay }
  function sunFor(ymd) {
    let s = sun.get(ymd);
    if (!s) {
      const [y, m, dd] = ymd.split("-").map(Number);
      const r = sunEventUTC(lat, lon, y, m, dd, true);
      const e = sunEventUTC(lat, lon, y, m, dd, false);
      s = {
        polarDay: !!(r.polarDay || e.polarDay),
        riseMs: r.ms !== undefined ? r.ms : null,
        setMs: e.ms !== undefined ? e.ms : null,
      };
      sun.set(ymd, s);
    }
    return s;
  }
  // An instant is in daylight when the most recent solar event before it is a
  // sunrise. Each computed event can sit a whole day off its true absolute
  // instant (the algorithm normalizes into [0, 24) on the given UTC date),
  // so every event is tried shifted by -24h/0/+24h; the true event is always
  // among the candidates, and a wrongly-shifted impostor can never slip
  // between the true latest event and the instant (true events are ~12h
  // apart, impostors 24h away).
  function isDaylight(ms) {
    const dayMs = 86400000;
    const base = Math.floor(ms / dayMs) * dayMs; // UTC midnight of ms's date
    let latest = null;
    for (let dOff = -1; dOff <= 1; dOff++) {
      const ymd = new Date(base + dOff * dayMs).toISOString().slice(0, 10);
      const s = sunFor(ymd);
      if (s.polarDay) return true;
      if (s.riseMs === null || s.setMs === null) continue; // polar night
      const events = [
        { t: s.riseMs, rise: true },
        { t: s.setMs, rise: false },
      ];
      for (const ev of events) {
        for (let k = -1; k <= 1; k++) {
          const c = ev.t + k * dayMs;
          if (c <= ms && (latest === null || c > latest.ms)) {
            latest = { ms: c, rise: ev.rise };
          }
        }
      }
    }
    return latest !== null && latest.rise;
  }
  const keepIdx = [];
  for (let i = 0; i < n; i++) {
    const t = data.time[i];
    let ms;
    if (typeof utcOffsetSeconds === "number") {
      ms = Date.parse(t.slice(0, 16) + ":00Z") - utcOffsetSeconds * 1000;
    } else {
      ms = Date.parse(t.length === 16 ? t + ":00Z" : (/Z$/i.test(t) ? t : t + "Z"));
    }
    if (!Number.isNaN(ms) && isDaylight(ms)) keepIdx.push(i);
  }
  const values = {};
  for (const [k, arr] of Object.entries(data.values || {})) {
    values[k] = keepIdx.map((i) => arr[i]);
  }
  return { ...data, time: keepIdx.map((i) => data.time[i]), values };
}
