// Lake catalogue: loads per-state lake lists and powers the search box.
"use strict";

/** Loaded state index: { "WI": "wi.json", ... } */
let lakeIndex = null;
/** Lakes for the currently selected state. */
let currentLakes = [];
/** Currently selected lake: {id, name, state, county, lat, lon} or null. */
let selectedLake = null;

const lakeSearchInput = document.getElementById("lake-search");
const lakeResultsList = document.getElementById("lake-results");
const lakeSelectedEl = document.getElementById("lake-selected");
const stateInput = document.getElementById("state");
const stateList = document.getElementById("state-list");
const statusEl = document.getElementById("status");

/** Code of the currently loaded state, "" when none. */
let currentStateCode = "";

/** Tell app.js (map) which lakes are currently shown; [] clears the map. */
function notifyLakesLoaded(lakes) {
  if (typeof window.__onLakesLoaded === "function") {
    window.__onLakesLoaded(lakes);
  }
}

/** Resolve typed text to a state code: "wisconsin"/"WI" -> "WI", "" -> "", else null. */
function resolveStateCode(text) {
  const t = text.trim().toLowerCase();
  if (!t) return "";
  const hit = STATES.find((st) => st.code.toLowerCase() === t || st.name.toLowerCase() === t);
  return hit ? hit.code : null;
}

async function initLakes() {
  try {
    const resp = await fetch("data/lakes/index.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    lakeIndex = await resp.json();
  } catch (err) {
    setStatus("Could not load the lake catalogue.", true);
    console.error("lake index load failed:", err);
    return;
  }

  // Populate the state datalist (type a name or pick from the dropdown).
  for (const st of STATES) {
    const byName = document.createElement("option");
    byName.value = st.name;
    stateList.appendChild(byName);
  }

  stateInput.addEventListener("input", () => {
    const code = resolveStateCode(stateInput.value);
    if (code === "" && currentStateCode) {
      onStateChange("");
    } else if (code && code !== currentStateCode) {
      onStateChange(code);
    }
  });
  stateInput.addEventListener("change", () => {
    // Fires on blur / Enter / datalist pick. Nudge if the text matches nothing.
    if (resolveStateCode(stateInput.value) === null && stateInput.value.trim() !== "") {
      setStatus(`"${stateInput.value.trim()}" doesn't match a US state — pick one from the list.`, true);
    }
  });
  lakeSearchInput.addEventListener("input", onSearchInput);
  lakeSearchInput.addEventListener("focus", () => {
    // Browsing: show the first lakes alphabetically even before typing.
    if (lakeSearchInput.value.trim() === "" && currentLakes.length > 0) {
      renderLakeMatches(currentLakes.slice(0, 50), true);
    }
  });
  document.addEventListener("click", (e) => {
    if (!lakeResultsList.contains(e.target) && e.target !== lakeSearchInput) {
      lakeResultsList.classList.remove("visible");
    }
  });
}

async function onStateChange(code) {
  currentStateCode = code || "";
  if (typeof highlightState === "function") highlightState(currentStateCode);
  currentLakes = [];
  selectedLake = null;
  lakeSelectedEl.textContent = "No lake selected.";
  lakeResultsList.classList.remove("visible");
  lakeResultsList.innerHTML = "";

  if (!code) {
    lakeSearchInput.disabled = true;
    lakeSearchInput.value = "";
    notifyLakesLoaded([]);
    return;
  }

  // Normalize what the user typed to the full state name.
  const st = STATES.find((s) => s.code === code);
  if (st && stateInput.value.trim().toLowerCase() !== st.name.toLowerCase()) {
    stateInput.value = st.name;
  }

  const file = lakeIndex.states && lakeIndex.states[code];
  if (!file) {
    lakeSearchInput.disabled = true;
    lakeSearchInput.value = "";
    setStatus("No lake data for this state yet — run scripts/build_lakes.py to generate the full US dataset.", true);
    notifyLakesLoaded([]);
    return;
  }

  try {
    const resp = await fetch(`data/lakes/${file}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    currentLakes = await resp.json();
  } catch (err) {
    setStatus(`Could not load lake data for ${code}.`, true);
    console.error("state lake load failed:", err);
    notifyLakesLoaded([]);
    return;
  }

  lakeSearchInput.disabled = false;
  lakeSearchInput.value = "";
  lakeSearchInput.placeholder = `Search ${currentLakes.length} lakes in ${code}…`;
  setStatus("");
  notifyLakesLoaded(currentLakes);
}

function onSearchInput() {
  const q = lakeSearchInput.value.trim().toLowerCase();
  if (!q || currentLakes.length === 0) {
    lakeResultsList.innerHTML = "";
    lakeResultsList.classList.remove("visible");
    return;
  }
  const matches = currentLakes
    .filter((l) => l.name.toLowerCase().includes(q))
    .slice(0, 50);
  renderLakeMatches(matches, false);
}

function renderLakeMatches(matches, isBrowsing) {
  lakeResultsList.innerHTML = "";
  if (matches.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No matches.";
    li.setAttribute("aria-disabled", "true");
    lakeResultsList.appendChild(li);
  } else {
    if (isBrowsing) {
      const hint = document.createElement("li");
      hint.textContent = `Showing first ${matches.length} of ${currentLakes.length} lakes — type to narrow down.`;
      hint.setAttribute("aria-disabled", "true");
      lakeResultsList.appendChild(hint);
    }
    for (const lake of matches) {
      const li = document.createElement("li");
      li.tabIndex = 0;
      li.textContent = `${lake.name} — ${lake.county || "unknown county"}`;
      const choose = () => selectLake(lake);
      li.addEventListener("click", choose);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); }
      });
      lakeResultsList.appendChild(li);
    }
  }
  lakeResultsList.classList.add("visible");
}

function selectLake(lake, opts) {
  selectedLake = lake;
  lakeSearchInput.value = lake.name;
  lakeResultsList.classList.remove("visible");
  lakeSelectedEl.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = lake.name;
  lakeSelectedEl.appendChild(strong);
  lakeSelectedEl.appendChild(document.createTextNode(
    ` — ${lake.county || "unknown county"}, ${lake.state} (${lake.lat.toFixed(3)}, ${lake.lon.toFixed(3)})`
  ));
  setStatus("");
  if (typeof window.__onLakeSelected === "function") {
    window.__onLakeSelected(lake, opts);
  }
}

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!isError);
}

function getSelectedLake() {
  return selectedLake;
}

document.addEventListener("DOMContentLoaded", initLakes);
