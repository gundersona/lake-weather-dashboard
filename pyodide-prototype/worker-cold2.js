// TEMPORARY PROTOTYPE - will be removed after measurement.
// Honest cold-load measurement: every byte is cache-busted (?cold=2) so the
// browser re-downloads everything, even though the profile is warm.
// Core runtime files are fetched explicitly (cold) for timing, then
// loadPyodide runs (CPU work); all package wheels are installed via micropip
// from cache-busted URLs in dependency order (sqlite3's zip can only come
// from loadPackage, so it is fetched cold for measurement but installed warm;
// it is ~100KB, noted in the log).
var PYODIDE_VERSION = "v0.26.1";
var INDEX_URL = "https://cdn.jsdelivr.net/pyodide/" + PYODIDE_VERSION + "/full/";
var CB = "?cold=2";
var WHEEL_URL = "https://gundersona.github.io/lake-weather-dashboard/pyodide-prototype/meteostat-2.1.5-py3-none-any.whl" + CB;
// NOTE: must be an absolute URL — requests rejects relative URLs
// ("MissingSchema"), which meteostat swallows as a download failure.
var STATIONS_DB_URL = "https://gundersona.github.io/lake-weather-dashboard/pyodide-prototype/stations.db" + CB;

var CORE_FILES = ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip"];
var PKG_WHEELS = [
  "numpy-1.26.4-cp312-cp312-pyodide_2024_0_wasm32.whl",
  "six-1.16.0-py2.py3-none-any.whl",
  "python_dateutil-2.9.0.post0-py2.py3-none-any.whl",
  "pytz-2024.1-py2.py3-none-any.whl",
  "pandas-2.2.0-cp312-cp312-pyodide_2024_0_wasm32.whl",
  "charset_normalizer-3.3.2-py3-none-any.whl",
  "idna-3.7-py3-none-any.whl",
  "urllib3-2.2.1-py3-none-any.whl",
  "certifi-2024.2.2-py3-none-any.whl",
  "requests-2.31.0-py3-none-any.whl",
  "packaging-23.2-py3-none-any.whl",
  "micropip-0.6.0-py3-none-any.whl",
  "pyodide_http-0.2.1-py3-none-any.whl"
];

function log(stage, msg) {
  postMessage({ type: "log", stage: stage, msg: msg });
}

var PY_QUERY =
  "from datetime import date, timedelta\n" +
  "import json\n" +
  "import numpy as np\n" +
  "import pandas as pd\n" +
  "import meteostat as ms\n" +
  "ms.config.stations_db_endpoints = [\"" + STATIONS_DB_URL + "\"]\n" +
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
  "    'year_last_date': dfy.index.max().strftime('%Y-%m-%d') if len(dfy) else None,\n" +
  "    'recent_rows': int(len(dfr)),\n" +
  "    'recent_max_date': dfr.index.max().strftime('%Y-%m-%d') if len(dfr) else None,\n" +
  "}\n" +
  "json.dumps(payload)\n";

async function main() {
  var t0 = performance.now();
  function dur(tStart) { return ((performance.now() - tStart) / 1000).toFixed(1); }

  log("init", "importScripts pyodide.js (cache-busted)");
  importScripts(INDEX_URL + "pyodide.js" + CB);

  var tA = performance.now();
  log("init", "loadPyodide() — core files cached here; cold download measured separately below");
  var pyodide = await loadPyodide({ indexURL: INDEX_URL });
  log("init", "runtime ready (CPU) in " + dur(tA) + "s");

  // Honest cold download of the 4 core runtime files (loadPyodide above used
  // cached copies, so this measures the bytes a true first visit downloads).
  var tCore = performance.now(), coreBytes = 0;
  for (var i = 0; i < CORE_FILES.length; i++) {
    var r = await fetch(INDEX_URL + CORE_FILES[i] + CB);
    var b = await r.arrayBuffer();
    coreBytes += b.byteLength;
  }
  // sqlite3 ships as a zip loadPackage-only; measure its bytes cold too
  var r2 = await fetch(INDEX_URL + "sqlite3-1.0.0.zip" + CB);
  var b2 = await r2.arrayBuffer();
  coreBytes += b2.byteLength;
  log("coredl", "core runtime + sqlite3 cold download: " + (coreBytes/1048576).toFixed(1) + " MB in " + dur(tCore) + "s");

  var tB = performance.now();
  var micropip = pyodide.pyimport("micropip");
  var pkgBytes = 0;
  log("packages", "micropip installing 13 wheels cold (?cold=2), dependency order, deps=false");
  for (var j = 0; j < PKG_WHEELS.length; j++) {
    var url = INDEX_URL + PKG_WHEELS[j] + CB;
    var tW = performance.now();
    await micropip.install(url, false, false);
    log("packages", "  " + PKG_WHEELS[j].split("-")[0] + " in " + dur(tW) + "s");
  }
  await pyodide.loadPackage(["sqlite3"]);
  log("packages", "stack ready in " + dur(tB) + "s");

  pyodide.pyimport("pyodide_http").patch_all();
  log("packages", "pyodide_http.patch_all() applied");

  var tC = performance.now();
  log("meteostat", "micropip installing vendored wheel (cache-busted)");
  await micropip.install(WHEEL_URL, false, false);
  var ver = pyodide.runPython("import meteostat; meteostat.__version__");
  log("meteostat", "meteostat " + ver + " installed in " + dur(tC) + "s");

  var tD = performance.now();
  log("query", "stations.nearby + daily(2024) + interpolate, Lake Mendota (stations.db downloads cold, 32.5 MB)");
  var jsonStr = pyodide.runPython(PY_QUERY);
  log("query", "query finished in " + dur(tD) + "s");

  var bytes = 0, resCount = 0;
  try {
    var entries = performance.getEntriesByType("resource");
    for (var k = 0; k < entries.length; k++) { resCount++; bytes += entries[k].transferSize || 0; }
  } catch (err) { /* resource timing unavailable */ }
  postMessage({ type: "done", totalSec: ((performance.now() - t0) / 1000).toFixed(1), bytes: bytes, resCount: resCount, payload: jsonStr });
}

main().catch(function(err) {
  postMessage({ type: "error", msg: String((err && err.message) || err) });
});
