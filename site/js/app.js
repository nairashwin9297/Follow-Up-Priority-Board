// Entry point: load our own JSON, rank it, hand the result to render.js.
// The browser only ever reads files from this site, never the Scout API.
import { archiveNotice, distributionSummary, failedUpdateText, freshnessText, utcLabel } from "./format.js";
import {
  COLUMNS, buildChart, buildSkyMap, buildTable, buildWeightsPanel, fillHistory, renderRows, showMessage, showNote,
} from "./render.js";
import { effectiveShares, priorityHistogram, rankObjects, sortRows, whyRankedHere } from "./score.js";
import { skyPoints, skySummary } from "./sky.js";

const $ = (id) => document.getElementById(id);
const archiveBanner = $("archive-banner");
const demoBanner = $("demo-banner");
const freshnessBanner = $("freshness");
const failedNote = $("failed-update");
const skyHost = $("sky-host");
const weightsHost = $("weights-host");
const chartHost = $("chart-host");
const fetchedNote = $("fetched-note");
const board = $("board-content");
const liveRegion = $("live");

const DEMO_TEXT = "Demo data from a saved test file. This is not a live Scout snapshot.";
const MINUTE_MS = 60 * 1000;

let generatedAt = null; // kept so the banners can age while the page stays open
let stopFetchingAfter = null; // last UTC day of fetching, from latest.json (null: no end date)
let failedText = null; // the "last update attempt failed" sentence, if any
let view = null; // everything the current screen needs, set after a successful load
let historyRequest = null; // history.json is fetched once, and only when a row is first opened

// no-cache: ask the server to revalidate, so a visitor never sees a stale copy after an update.
async function getJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

// Recomputed from the clock every minute, so it keeps working even if the pipeline is dead.
// Past the end date the board is an archive: say so, and drop the "out of date" and "update failed"
// lines. An archive is old on purpose, and those would only repeat it in red.
function updateBanners() {
  if (generatedAt === null) return;
  const archived = archiveNotice(stopFetchingAfter, generatedAt, Date.now());
  showNote(archiveBanner, archived, "archived");
  if (archived) {
    showNote(freshnessBanner, null);
    showNote(failedNote, null);
    return;
  }
  const { level, text } = freshnessText(generatedAt, Date.now());
  showNote(freshnessBanner, text, level);
  showNote(failedNote, failedText, "failed");
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
  const { latest, scoring, weights, sort, expanded, selected, panel, table, chart, sky } = view;
  panel.update(weights, effectiveShares(weights));
  const ranked = rankObjects(latest.objects, weights);
  const histogram = priorityHistogram(ranked);
  chart.update(histogram, distributionSummary(histogram));
  const positions = skyPoints(ranked);
  sky.update(positions, skySummary(positions), selected);
  table.setCaption(`Unconfirmed NEO candidates, ranked by illustrative follow-up priority (${ranked.length} objects)`);
  table.setSort(sort.key, sort.dir);
  renderRows(table.table, sortRows(ranked, sort.key, sort.dir), {
    scoring,
    expanded,
    selected,
    why: (row) => whyRankedHere(row, scoring),
    onOpen: showHistory,
  });
}

// Picking an object on the sky map: open its table row, scroll to it, and move focus there so a
// keyboard user continues from the row.
function openRow(name) {
  view.expanded.add(name);
  view.selected = name;
  refresh();
  const toggle = view.table.table.querySelector(`.row-toggle[data-object="${CSS.escape(name)}"]`);
  if (!toggle) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  toggle.focus({ preventScroll: true });
  toggle.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  announce(`Opened ${name} in the table.`);
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
  stopFetchingAfter = null;
  failedText = null;
  view = null;
  historyRequest = null;
  for (const note of [archiveBanner, demoBanner, freshnessBanner, failedNote]) showNote(note, null);
  skyHost.replaceChildren();
  weightsHost.replaceChildren();
  chartHost.replaceChildren();
  fetchedNote.textContent = "Fetch time unknown.";
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
  fetchedNote.textContent = `Fetched ${utcLabel(generatedAt)}.`;
  stopFetchingAfter = latest.stop_fetching_after ?? null;
  failedText = failedUpdateText(await statusRequest);
  updateBanners();
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
    selected: null, // the object last picked on the sky map
    panel: buildWeightsPanel(weightsHost, scoring, { onChange: onWeightChange, onReset }),
    table: buildTable(board, { onSort }),
    chart: buildChart(chartHost),
    sky: buildSkyMap(skyHost, { onSelect: openRow }),
  };
  refresh();
}

setInterval(updateBanners, MINUTE_MS);
load();
