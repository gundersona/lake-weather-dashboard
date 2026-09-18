// TEMPORARY PROTOTYPE - will be removed after measurement.
// Runs the real Meteostat Python library inside Pyodide (WASM) in a Web Worker.
var PYODIDE_VERSION = "v0.26.1";
var INDEX_URL = "https://unpkg.com/pyodide@0.26.1/full/"; // unpkg = separate origin, forces full re-download for the cold test
var WHEEL_URL = "https://gundersona.github.io/lake-weather-dashboard/pyodide-prototype/meteostat-2.1.5-py3-none-any.whl?cold=1";
// Same-origin stations database (32.5 MB), vendored for this prototype run.
// Set to null to use Meteostat's remote stations.db endpoints instead.
// NOTE: must be an absolute URL — requests rejects relative URLs
// ("MissingSchema"), which meteostat swallows as a download failure.
var STATIONS_DB_URL = "https://gundersona.github.io/lake-weather-dashboard/pyodide-prototype/stations.db?cold=1";

function log(stage, msg) {
  postMessage({ type: "log", stage: stage, msg: msg });
}

// NOTE: "__STATIONS_DB__" is replaced at build time with a Python line that
// points meteostat at the same-origin stations.db, or "" for the remote path.
var PY_QUERY =
  "from datetime import date, timedelta\n" +
  "import json\n" +
  "import numpy as np\n" +
  "import pandas as pd\n" +
  "import meteostat as ms\n" +
  "__STATIONS_DB__" +
  "POINT = ms.Point(43.1067, -89.4012, 259)\n" +
  "stations_df = ms.stations.nearby(POINT, limit=4)\n" +
  "def frame_to_records(df, n=5):\n" +
  "    out = df.reset_index().copy()\n" +
  "    if 'time' in out.columns:\n" +
  "        out['time'] = out['time'].dt.strftime('%Y-%m-%d')\n" +
  "    out = out.where(pd.notnull(out), None)\n" +
  "    recs = out.head(n).to_dict(orient='records')\n" +
  "    return json.loads(json.dumps(recs, default=lambda o: float(o) if isinstance(o, (np.integer, np.floating)) else str(o)))\n" +
  "ts = ms.daily(stations_df, date(2024, 1, 1), date(2024, 12, 31))\n" +
  "dfy = ms.interpolate(ts, POINT).fetch()\n" +
  "end = date.today()\n" +
  "start = end - timedelta(days=30)\n" +
  "ts2 = ms.daily(stations_df, start, end)\n" +
  "dfr = ms.interpolate(ts2, POINT).fetch()\n" +
  "st = stations_df.reset_index()\n" +
  "ids = st['id'].tolist() if 'id' in st.columns else st.index.astype(str).tolist()\n" +
  "payload = {\n" +
  "    'station_ids': ids,\n" +
  "    'columns': [str(c) for c in dfy.columns],\n" +
  "    'year_rows': int(len(dfy)),\n" +
  "    'year_first_date': dfy.index.min().strftime('%Y-%m-%d') if len(dfy) else None,\n" +
  "    'year_last_date': dfy.index.max().strftime('%Y-%m-%d') if len(dfy) else None,\n" +
  "    'year_sample': frame_to_records(dfy),\n" +
  "    'recent_rows': int(len(dfr)),\n" +
  "    'recent_max_date': dfr.index.max().strftime('%Y-%m-%d') if len(dfr) else None,\n" +
  "    'recent_sample': frame_to_records(dfr),\n" +
  "}\n" +
  "json.dumps(payload)\n";

if (STATIONS_DB_URL) {
  PY_QUERY = PY_QUERY.replace("__STATIONS_DB__", "ms.config.stations_db_endpoints = [\"" + STATIONS_DB_URL + "\"]\n");
} else {
  PY_QUERY = PY_QUERY.replace("__STATIONS_DB__", "");
}

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

  // Route Python HTTP (requests) through the browser's fetch/XHR, otherwise
  // meteostat's downloads fail inside the WASM runtime.
  pyodide.pyimport("pyodide_http").patch_all();
  log("packages", "pyodide_http.patch_all() applied");

  var tC = performance.now();
  log("meteostat", "micropip installing vendored wheel (same origin, deps already loaded)");
  var micropip = pyodide.pyimport("micropip");
  // deps=false: Pyodide's stack (pytz 2024.1, pandas 2.2.0) already satisfies
  // meteostat at runtime; its metadata pins (pytz<2024.0, pandas>=2.3.0)
  // conflict with the prebuilt stack and would abort the install.
  // Positional: install(requirements, keep_going, deps). JS has no kwargs,
  // so micropip.install(url, deps=false) would silently misassign.
  await micropip.install(WHEEL_URL, false, false);
  var ver = pyodide.runPython("import meteostat; meteostat.__version__");
  log("meteostat", "meteostat " + ver + " installed in " + dur(tC) + "s");

  var tD = performance.now();
  log("query", "stations.nearby + daily(2024) + interpolate, Lake Mendota");
  var jsonStr = pyodide.runPython(PY_QUERY);
  log("query", "query finished in " + dur(tD) + "s");

  var bytes = 0, resCount = 0;
  try {
    var entries = performance.getEntriesByType("resource");
    for (var i = 0; i < entries.length; i++) { resCount++; bytes += entries[i].transferSize || 0; }
  } catch (err) { /* resource timing unavailable */ }
  postMessage({ type: "done", totalSec: ((performance.now() - t0) / 1000).toFixed(1), bytes: bytes, resCount: resCount, payload: jsonStr });
}

main().catch(function(err) {
  postMessage({ type: "error", msg: String((err && err.message) || err) });
});
