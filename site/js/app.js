// Entry point: load our own JSON, rank it, hand the result to render.js.
// The browser only ever reads files from this site, never the Scout API.
import { failedUpdateText, freshnessText } from "./format.js";
import { COLUMNS, buildTable, buildWeightsPanel, fillHistory, renderRows, showMessage, showNote } from "./render.js";
import { effectiveShares, rankObjects, sortRows, whyRankedHere } from "./score.js";

const $ = (id) => document.getElementById(id);
const demoBanner = $("demo-banner");
const freshnessBanner = $("freshness");
const failedNote = $("failed-update");
const weightsHost = $("weights-host");
const board = $("board-content");
const liveRegion = $("live");

const DEMO_TEXT = "Demo data from a saved test file. This is not a live Scout snapshot.";
const MINUTE_MS = 60 * 1000;

let generatedAt = null; // kept so the banner can age while the page stays open
let view = null; // everything the current screen needs, set after a successful load
let historyRequest = null; // history.json is fetched once, and only when a row is first opened

// no-cache: ask the server to revalidate, so a visitor never sees a stale copy after an update.
async function getJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

// Recomputed from the clock every minute, so it keeps working even if the pipeline is dead.
function updateFreshness() {
  if (generatedAt === null) return;
  const { level, text } = freshnessText(generatedAt, Date.now());
  showNote(freshnessBanner, text, level);
}

// Screen-reader announcements (the aria-live region). Debounced so dragging a slider
// produces one "Ranking updated" at the end, not one per step.
let announceTimer = null;
function announce(text) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    liveRegion.textContent = ""; // clear first so repeating the same text is announced again
    announceTimer = setTimeout(() => { liveRegion.textContent = text; }, 50);
  }, 400);
}

function loadHistory() {
  historyRequest ??= getJson("data/history.json").catch((error) => {
    historyRequest = null; // allow another try the next time a row is opened
    throw error;
  });
  return historyRequest;
}

async function showHistory(name, slot) {
  fillHistory(slot, { status: "loading" });
  try {
    const history = await loadHistory();
    fillHistory(slot, { status: "ready", entry: history.objects?.[name] ?? null });
  } catch (error) {
    console.error(error);
    fillHistory(slot, { status: "error" });
  }
}

// Re-score, re-sort and redraw the rows. The header and sliders are updated, not rebuilt.
function refresh() {
  const { latest, scoring, weights, sort, expanded, panel, table } = view;
  panel.update(weights, effectiveShares(weights));
  const ranked = rankObjects(latest.objects, weights);
  table.setCaption(`Unconfirmed NEO candidates, ranked by illustrative follow-up priority (${ranked.length} objects)`);
  table.setSort(sort.key, sort.dir);
  renderRows(table.table, sortRows(ranked, sort.key, sort.dir), {
    scoring,
    expanded,
    why: (row) => whyRankedHere(row, scoring),
    onOpen: showHistory,
  });
}

function onWeightChange(name, value) {
  view.weights[name] = value;
  refresh();
  announce("Ranking updated");
}

function onReset() {
  view.weights = { ...view.scoring.weights };
  refresh();
  announce("Weights reset to defaults. Ranking updated");
}

function onSort(key) {
  const column = COLUMNS.find((c) => c.key === key);
  const { sort } = view;
  // Clicking the active column flips it; a new column starts in its natural direction.
  view.sort = sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: column.sort };
  refresh();
  announce(`Sorted by ${column.label}, ${view.sort.dir === "asc" ? "ascending" : "descending"}.`);
}

async function load() {
  generatedAt = null;
  view = null;
  historyRequest = null;
  for (const note of [demoBanner, freshnessBanner, failedNote]) showNote(note, null);
  weightsHost.replaceChildren();
  showMessage(board, { kind: "loading", title: "Loading…", text: "Reading the latest snapshot." });

  // status.json only adds a warning line, so a failure to load it is not fatal.
  const statusRequest = getJson("data/status.json").catch((error) => {
    console.warn("status.json unavailable:", error);
    return null;
  });

  let latest, scoring;
  try {
    [latest, scoring] = await Promise.all([getJson("data/latest.json"), getJson("data/scoring.json")]);
    if (latest.schema_version !== 1 || !Array.isArray(latest.objects)) {
      throw new Error("data/latest.json is in a format this page doesn't understand");
    }
  } catch (error) {
    console.error(error);
    showMessage(board, {
      kind: "error",
      title: "Couldn't load the data",
      text: `${error.message}. Check your connection and try again.`,
      onRetry: load,
    });
    return;
  }

  generatedAt = latest.generated_at;
  updateFreshness();
  showNote(failedNote, failedUpdateText(await statusRequest), "failed");
  showNote(demoBanner, latest.source === "fixture" ? DEMO_TEXT : null, "demo");

  if (latest.objects.length === 0) {
    showMessage(board, {
      kind: "empty",
      title: "No objects right now",
      text: "Scout isn't listing any unconfirmed candidates in this snapshot.",
    });
    return;
  }

  view = {
    latest,
    scoring,
    weights: { ...scoring.weights },
    sort: { key: "rank", dir: "asc" },
    expanded: new Set(), // object names whose detail row is open; survives re-sorting
    panel: buildWeightsPanel(weightsHost, scoring, { onChange: onWeightChange, onReset }),
    table: buildTable(board, { onSort }),
  };
  refresh();
}

setInterval(updateFreshness, MINUTE_MS);
load();
