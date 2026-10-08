// Unit tests for the temp-filter mean/min basis, day-count stats, and
// ranking {match, eligible, monthDays} plumbing. Run: node scripts/test-temp-basis.js
const fs = require("fs");
const wr = fs.readFileSync("js/windrank.js", "utf8");
const app = fs.readFileSync("js/app.js", "utf8");
function grab(src, name) {
  const m = src.match(new RegExp("function " + name + "[\\s\\S]*?\\n\\}"));
  if (!m) throw new Error("missing " + name);
  return m[0];
}
const fns = [
  grab(wr, "windrankDayBuckets"),
  grab(wr, "windrankDayPassesTemp"),
  grab(wr, "windrankLakeDays"),
  grab(wr, "windrankLakeAvg"),
  grab(app, "computeDayInfo"),
  grab(app, "filterDataToDays"),
  grab(app, "applySharedFilters"),
  grab(app, "tempFilterSummary"),
].join("\n");
const F = new Function("filterDaylight",
  fns + "; return {windrankDayBuckets,windrankDayPassesTemp,windrankLakeDays,windrankLakeAvg,computeDayInfo,filterDataToDays,applySharedFilters,tempFilterSummary};");
const f = F(null);
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name); }
}

// --- windrank: mean vs min basis ---
// day1 temps [30,32,50] -> mean 37.33, min 30 ; day2 temps [36,37,38] -> mean 37, min 36
const s = {
  time: ["2024-06-01T00:00", "2024-06-01T01:00", "2024-06-01T02:00",
         "2024-06-02T00:00", "2024-06-02T01:00", "2024-06-02T02:00"],
  wind: [2, 2, 2, 2, 2, 2],
  temp: [30, 32, 50, 36, 37, 38],
};
const lake = { lat: 43, lon: -89 };
const tr = { min: 35, max: null };
const rMean = f.windrankLakeDays(lake, s, [6], tr, true, "mean", 0, 5, 1, false);
const rMin = f.windrankLakeDays(lake, s, [6], tr, true, "min", 0, 5, 1, false);
check("mean basis: both days eligible (means 37.33, 37)",
  rMean.eligible === 2 && rMean.match === 2 && rMean.monthDays === 2);
check("min basis: only day2 eligible (min 30 < 35)",
  rMin.eligible === 1 && rMin.match === 1 && rMin.monthDays === 2);
const aMin = f.windrankLakeAvg(lake, s, [6], tr, true, "min", false);
check("avg basis min: eligible=1, avg=2, monthDays=2",
  aMin.eligible === 1 && aMin.avg === 2 && aMin.monthDays === 2);
const rOff = f.windrankLakeDays(lake, s, [6], { min: null, max: null }, false, "mean", 0, 5, 1, false);
check("temp inactive: all eligible", rOff.eligible === 2 && rOff.monthDays === 2);
// max bound under min basis: day's coldest hour must be <= max
const rMaxMin = f.windrankLakeDays(lake, s, [6], { min: null, max: 34 }, true, "min", 0, 5, 1, false);
check("min basis max bound: day1 (min 30) passes, day2 (min 36) dropped", rMaxMin.eligible === 1);

// --- app.js applySharedFilters stats + basis ---
const data = {
  time: ["2024-06-01T00:00", "2024-06-01T01:00", "2024-07-01T00:00", "2024-07-01T01:00"],
  values: { temperature_2m: [30, 40, 36, 38], wind_speed_10m: [1, 1, 1, 1] },
  resolution: "hourly",
};
const out = f.applySharedFilters(data, [6, 7], { min: 35, max: null }, true, "min");
check("app min basis: keeps only 07-01 (day1 min 30)",
  out.keptDays === 1 && out.data.time.length === 2 && out.monthDays === 2 && out.totalDays === 2);
const out2 = f.applySharedFilters(data, [6, 7], { min: 35, max: null }, true, "mean");
check("app mean basis: keeps both (means 35, 37)", out2.keptDays === 2);
const out3 = f.applySharedFilters(data, [7], { min: 35, max: null }, true, "mean");
check("month filter: monthDays=1, keptDays=1", out3.monthDays === 1 && out3.keptDays === 1);
const out4 = f.applySharedFilters(data, [7], { min: 90, max: null }, true, "mean");
check("none match: data null, keptDays 0", out4.data === null && out4.keptDays === 0 && out4.monthDays === 1);
const sum = f.tempFilterSummary({ monthDays: 7, keptDays: 4 }, { min: 35, max: null }, true, "min");
check("tempFilterSummary text",
  sum === " Temp filter (daily min 35–…°F): 4 of 7 days kept (3 removed).");
const sumOff = f.tempFilterSummary({ monthDays: 7, keptDays: 7 }, { min: null, max: null }, false, "mean");
check("tempFilterSummary inactive -> empty", sumOff === "");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
