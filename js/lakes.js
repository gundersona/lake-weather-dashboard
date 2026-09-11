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
const stateSelect = document.getElementById("state");
const statusEl = document.getElementById("status");

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

  // Populate the state dropdown from config STATES, marking which have data.
  const statesWithData = new Set(Object.keys(lakeIndex.states || {}));
  for (const st of STATES) {
    const opt = document.createElement("option");
    opt.value = st.code;
    opt.textContent = statesWithData.has(st.code) ? st.name : `${st.name} (no data yet)`;
    stateSelect.appendChild(opt);
  }

  stateSelect.addEventListener("change", onStateChange);
  lakeSearchInput.addEventListener("input", onSearchInput);
  document.addEventListener("click", (e) => {
    if (!lakeResultsList.contains(e.target) && e.target !== lakeSearchInput) {
      lakeResultsList.classList.remove("visible");
    }
  });
}

async function onStateChange() {
  const code = stateSelect.value;
  currentLakes = [];
  selectedLake = null;
  lakeSelectedEl.textContent = "No lake selected.";
  lakeResultsList.classList.remove("visible");
  lakeResultsList.innerHTML = "";

  if (!code) {
    lakeSearchInput.disabled = true;
    lakeSearchInput.value = "";
    return;
  }

  const file = lakeIndex.states && lakeIndex.states[code];
  if (!file) {
    lakeSearchInput.disabled = true;
    lakeSearchInput.value = "";
    setStatus("No lake data for this state yet — run scripts/build_lakes.py to generate the full US dataset.", true);
    return;
  }

  try {
    const resp = await fetch(`data/lakes/${file}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    currentLakes = await resp.json();
  } catch (err) {
    setStatus(`Could not load lake data for ${code}.`, true);
    console.error("state lake load failed:", err);
    return;
  }

  lakeSearchInput.disabled = false;
  lakeSearchInput.value = "";
  lakeSearchInput.placeholder = `Search ${currentLakes.length} lakes in ${code}…`;
  setStatus("");
}

function onSearchInput() {
  const q = lakeSearchInput.value.trim().toLowerCase();
  lakeResultsList.innerHTML = "";
  if (!q || currentLakes.length === 0) {
    lakeResultsList.classList.remove("visible");
    return;
  }
  const matches = currentLakes
    .filter((l) => l.name.toLowerCase().includes(q))
    .slice(0, 50);

  if (matches.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No matches.";
    li.setAttribute("aria-disabled", "true");
    lakeResultsList.appendChild(li);
  } else {
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

function selectLake(lake) {
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
    window.__onLakeSelected(lake);
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
