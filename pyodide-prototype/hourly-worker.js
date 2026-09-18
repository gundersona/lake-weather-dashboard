// TEMPORARY PROTOTYPE - will be removed after measurement.
// Hourly freshness check: how recent is Meteostat's hourly data for Lake Mendota?
var PYODIDE_VERSION = "v0.26.1";
var INDEX_URL = "https://cdn.jsdelivr.net/pyodide/" + PYODIDE_VERSION + "/full/";
var WHEEL_URL = "https://gundersona.github.io/lake-weather-dashboard/pyodide-prototype/meteostat-2.1.5-py3-none-any.whl";
var STATIONS_DB_URL = "https://gundersona.github.io/lake-weather-dashboard/pyodide-prototype/stations.db";

function log(stage, msg) {
  postMessage({ type: "log", stage: stage, msg: msg });
}

var PY_QUERY =
  "from datetime import datetime, timedelta, timezone\n" +
  "import json\n" +
  "import meteostat as ms\n" +
  "ms.config.stations_db_endpoints = [\"" + STATIONS_DB_URL + "\"]\n" +
  "POINT = ms.Point(43.1067, -89.4012, 259)\n" +
  "stations_df = ms.stations.nearby(POINT, limit=4)\n" +
  "end = datetime.now()\n" +
  "start = end - timedelta(days=7)\n" +
  "ts = ms.hourly(stations_df, start, end)\n" +
  "dfh = ms.interpolate(ts, POINT).fetch()\n" +
  "mx = dfh.index.max()\n" +
  "now = datetime.now(timezone.utc)\n" +
  "lag_h = (now - mx.tz_convert('UTC').to_pydatetime()).total_seconds() / 3600\n" +
  "st = stations_df.reset_index()\n" +
  "ids = st['id'].tolist() if 'id' in st.columns else st.index.astype(str).tolist()\n" +
  "payload = {\n" +
  "    'station_ids': ids,\n" +
  "    'hourly_rows': int(len(dfh)),\n" +
  "    'hourly_first_time': dfh.index.min().isoformat() if len(dfh) else None,\n" +
  "    'hourly_max_time': mx.isoformat() if len(dfh) else None,\n" +
  "    'now_utc': now.isoformat(),\n" +
  "    'lag_hours': round(float(lag_h), 1),\n" +
  "}\n" +
  "json.dumps(payload)\n";

async function main() {
  var t0 = performance.now();
  function dur(tStart) { return ((performance.now() - tStart) / 1000).toFixed(1); }

  log("init", "importScripts pyodide.js");
  importScripts(INDEX_URL + "pyodide.js");

  var tA = performance.now();
  log("init", "loadPyodide()");
  var pyodide = await loadPyodide({ indexURL: INDEX_URL });
  log("init", "runtime ready in " + dur(tA) + "s");

  var tB = performance.now();
  log("packages", "loadPackage numpy/pandas/pytz/requests/micropip/sqlite3/pyodide-http");
  await pyodide.loadPackage(["numpy", "pandas", "pytz", "requests", "micropip", "sqlite3", "pyodide-http"]);
  log("packages", "stack ready in " + dur(tB) + "s");

  pyodide.pyimport("pyodide_http").patch_all();
  log("packages", "pyodide_http.patch_all() applied");

  var tC = performance.now();
  log("meteostat", "micropip installing vendored wheel (same origin, deps already loaded)");
  var micropip = pyodide.pyimport("micropip");
  await micropip.install(WHEEL_URL, false, false);
  var ver = pyodide.runPython("import meteostat; meteostat.__version__");
  log("meteostat", "meteostat " + ver + " installed in " + dur(tC) + "s");

  var tD = performance.now();
  log("query", "stations.nearby + hourly(last 7 days) + interpolate, Lake Mendota");
  var jsonStr = pyodide.runPython(PY_QUERY);
  log("query", "query finished in " + dur(tD) + "s");

  postMessage({ type: "done", totalSec: ((performance.now() - t0) / 1000).toFixed(1), payload: jsonStr });
}

main().catch(function(err) {
  postMessage({ type: "error", msg: String((err && err.message) || err) });
});
