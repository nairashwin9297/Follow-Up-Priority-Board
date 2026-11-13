// Small pure helpers for text and freshness. No DOM, so `node --test` can run them.
//
// Freshness is computed here, in the browser, from generated_at and the current
// time. That way the page still warns visitors when the pipeline has died.

export const AGING_HOURS = 12; // from here on: amber warning
export const STALE_HOURS = 24; // beyond this: red "may be out of date"
const HOUR_MS = 3600 * 1000;

export function formatNumber(value, digits = 0) {
  return value == null || Number.isNaN(value) ? "—" : Number(value).toFixed(digits);
}

// For values that span orders of magnitude (uncertainty runs 0.01 to ~4800 arcmin):
// fewer decimals as the number grows, so small values keep their detail.
export function formatSmart(value) {
  if (value == null || Number.isNaN(value)) return "—";
  const size = Math.abs(value);
  return Number(value).toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2);
}

// Pixel positions for a sparkline. Points are evenly spaced by snapshot number (snapshots
// are not evenly spaced in time) and scaled to the series' own range. A log scale is used
// when every value is positive, because uncertainty can change by orders of magnitude.
export function sparklinePoints(values, width, height, pad = 2) {
  const scaled = values.every((v) => v > 0) ? values.map(Math.log10) : values;
  const lo = Math.min(...scaled);
  const span = Math.max(...scaled) - lo;
  const step = values.length > 1 ? (width - 2 * pad) / (values.length - 1) : 0;
  return scaled.map((v, i) => [
    pad + i * step,
    span === 0 ? height / 2 : height - pad - ((v - lo) / span) * (height - 2 * pad),
  ]);
}

// "2026-11-13T01:41:25Z" -> "2026-11-13 01:41 UTC"
export function utcLabel(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "an unknown time";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

export function relativeTime(ageMs) {
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.floor(hours / 24), "day");
}

// level is "fresh" (<12 h), "aging" (12-24 h), "stale" (>24 h) or "unknown" (unreadable date).
export function freshness(generatedAt, nowMs) {
  const generatedMs = Date.parse(generatedAt);
  if (Number.isNaN(generatedMs)) return { level: "unknown", ageMs: null };
  // A clock a little behind ours could make the age negative; show that as "just now".
  const ageMs = Math.max(0, nowMs - generatedMs);
  let level = "fresh";
  if (ageMs > STALE_HOURS * HOUR_MS) level = "stale";
  else if (ageMs >= AGING_HOURS * HOUR_MS) level = "aging";
  return { level, ageMs };
}

// The words carry the meaning; color is only an extra cue.
export function freshnessText(generatedAt, nowMs) {
  const { level, ageMs } = freshness(generatedAt, nowMs);
  if (level === "unknown") return { level, text: "Warning: can't tell when this data was fetched." };
  const when = `${relativeTime(ageMs)} (${utcLabel(generatedAt)})`;
  if (level === "stale") return { level, text: `Data may be out of date. Fetched ${when}.` };
  if (level === "aging") return { level, text: `Warning: data fetched ${when}. Updates may be delayed.` };
  return { level, text: `Data fetched ${when}.` };
}

// Returns the sentence to show, or null when the last update attempt did not fail.
export function failedUpdateText(status) {
  if (!status || status.ok !== false) return null;
  return `The last update attempt failed at ${utcLabel(status.last_attempt)}.`;
}
