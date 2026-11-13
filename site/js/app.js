// Entry point: load our own JSON, rank it, hand the result to render.js.
// The browser only ever reads files from this site, never the Scout API.
import { failedUpdateText, freshnessText } from "./format.js";
import { renderTable, showMessage, showNote } from "./render.js";
import { rankObjects } from "./score.js";

const $ = (id) => document.getElementById(id);
const demoBanner = $("demo-banner");
const freshnessBanner = $("freshness");
const failedNote = $("failed-update");
const board = $("board-content");

const DEMO_TEXT = "Demo data from a saved test file. This is not a live Scout snapshot.";
const MINUTE_MS = 60 * 1000;

let generatedAt = null; // kept so the banner can age while the page stays open

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

async function load() {
  generatedAt = null;
  for (const note of [demoBanner, freshnessBanner, failedNote]) showNote(note, null);
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
  renderTable(board, rankObjects(latest.objects, scoring.weights));
}

setInterval(updateFreshness, MINUTE_MS);
load();
