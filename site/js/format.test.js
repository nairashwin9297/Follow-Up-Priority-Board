// Run with: node --test site/js
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  archiveNotice, binLabel, distributionSummary, failedUpdateText, formatNumber, formatSmart, freshness, freshnessText,
  niceTicks, relativeTime, sparklinePoints, utcLabel,
} from "./format.js";

const GENERATED = "2026-11-13T00:00:00Z";
const T0 = Date.parse(GENERATED);
const HOUR = 3600 * 1000;
const at = (hours, extraMs = 0) => T0 + hours * HOUR + extraMs;

test("formatNumber shows a dash for missing values", () => {
  assert.equal(formatNumber(null), "—");
  assert.equal(formatNumber(undefined), "—");
  assert.equal(formatNumber(NaN), "—");
  assert.equal(formatNumber(0, 1), "0.0");
  assert.equal(formatNumber(12.345, 1), "12.3");
  assert.equal(formatNumber(7), "7");
});

test("formatSmart keeps detail for small values and trims big ones", () => {
  assert.equal(formatSmart(null), "—");
  assert.equal(formatSmart(0.01), "0.01");
  assert.equal(formatSmart(8.894), "8.89");
  assert.equal(formatSmart(10), "10.0");
  assert.equal(formatSmart(99.94), "99.9");
  assert.equal(formatSmart(450.67), "451");
  assert.equal(formatSmart(4800), "4800");
});

test("binLabel says 'under' except for the last bin, which includes its upper edge", () => {
  assert.equal(binLabel({ lo: 10, hi: 20 }, false), "10 to under 20");
  assert.equal(binLabel({ lo: 90, hi: 100 }, true), "90 to 100");
});

test("niceTicks gives round numbers from 0 up to at or above the max, in at most 4 steps", () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(-3), [0, 1]);
  assert.deepEqual(niceTicks(1), [0, 1]);
  assert.deepEqual(niceTicks(3), [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(5), [0, 2, 4, 6]);
  assert.deepEqual(niceTicks(9), [0, 5, 10]);
  assert.deepEqual(niceTicks(17), [0, 5, 10, 15, 20]);
  assert.deepEqual(niceTicks(53), [0, 20, 40, 60]);
  for (const max of [1, 2, 7, 13, 26, 49, 120, 999]) {
    const ticks = niceTicks(max);
    assert.ok(ticks.at(-1) >= max && ticks.length <= 5, `max ${max}: ${ticks}`);
  }
});

const hist = (counts, extra = {}) => ({
  bins: counts.map((count, i) => ({ lo: i * 10, hi: i * 10 + 10, count })),
  total: counts.reduce((a, b) => a + b, 0), scored: counts.reduce((a, b) => a + b, 0), unscored: 0,
  max: 65.64, median: 31.25, ...extra,
});

test("distributionSummary describes the shape in words", () => {
  const text = distributionSummary(hist([0, 2, 9, 6, 3, 2, 1, 0, 0, 0]));
  assert.equal(text, "Priority scores for 23 objects. Highest: 65.6. Median: 31.3. " +
    "Most common range: 20 to under 30 (9 objects).");
});

test("distributionSummary handles singular nouns, ties, the last bin and unscored objects", () => {
  assert.match(distributionSummary(hist([1, 0, 0, 0, 0, 0, 0, 0, 0, 0])), /^Priority scores for 1 object\./);
  assert.match(distributionSummary(hist([3, 3, 0, 0, 0, 0, 0, 0, 0, 0])), /Most common range: 0 to under 10 \(3 objects\)/);
  assert.match(distributionSummary(hist([0, 0, 0, 0, 0, 0, 0, 0, 0, 4])), /Most common range: 90 to 100 \(4 objects\)/);
  const withGaps = distributionSummary(hist([1, 1, 0, 0, 0, 0, 0, 0, 0, 0], { total: 4, unscored: 2 }));
  assert.match(withGaps, /2 objects have no priority score and are not shown\.$/);
  assert.match(distributionSummary(hist([1, 0, 0, 0, 0, 0, 0, 0, 0, 0], { total: 2, unscored: 1 })), /1 object has no priority score and is not shown\.$/);
});

test("distributionSummary when there is nothing to show", () => {
  assert.equal(distributionSummary(hist([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { total: 0, scored: 0, max: null, median: null })),
    "There are no objects to chart.");
  assert.equal(distributionSummary(hist([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { total: 3, scored: 0, unscored: 3, max: null, median: null })),
    "None of the 3 objects has a priority score.");
});

test("sparklinePoints: ends at the padding, higher values sit higher (smaller y)", () => {
  const pts = sparklinePoints([5, 10, 20], 100, 40, 2);
  assert.equal(pts.length, 3);
  assert.deepEqual([pts[0][0], pts[2][0]], [2, 98]);
  assert.equal(pts[0][1], 38); // lowest value at the bottom edge (height - pad)
  assert.equal(pts[2][1], 2); // highest value at the top edge
  assert.ok(pts[1][1] < pts[0][1] && pts[1][1] > pts[2][1]);
});

test("sparklinePoints uses a log scale when all values are positive", () => {
  const ys = sparklinePoints([1, 10, 100], 100, 42, 1).map(([, y]) => y);
  assert.ok(Math.abs((ys[0] - ys[1]) - (ys[1] - ys[2])) < 1e-9); // equal steps per decade
});

test("sparklinePoints falls back to linear when a value is zero, and centers flat series", () => {
  const ys = sparklinePoints([0, 5, 10], 100, 42, 1).map(([, y]) => y);
  assert.ok(Math.abs((ys[0] - ys[1]) - (ys[1] - ys[2])) < 1e-9);
  assert.deepEqual(sparklinePoints([7, 7, 7], 100, 40).map(([, y]) => y), [20, 20, 20]);
});

test("utcLabel formats to the minute in UTC", () => {
  assert.equal(utcLabel("2026-11-13T01:41:25Z"), "2026-11-13 01:41 UTC");
  assert.equal(utcLabel("garbage"), "an unknown time");
});

test("relativeTime picks minutes, hours or days with correct plurals", () => {
  assert.equal(relativeTime(0), "just now");
  assert.equal(relativeTime(59 * 1000), "just now");
  assert.equal(relativeTime(60 * 1000), "1 minute ago");
  assert.equal(relativeTime(59 * 60 * 1000), "59 minutes ago");
  assert.equal(relativeTime(HOUR), "1 hour ago");
  assert.equal(relativeTime(23 * HOUR + 59 * 60 * 1000), "23 hours ago");
  assert.equal(relativeTime(24 * HOUR), "1 day ago");
  assert.equal(relativeTime(50 * HOUR), "2 days ago");
});

test("freshness boundaries: <12 h fresh, 12-24 h aging, >24 h stale", () => {
  assert.equal(freshness(GENERATED, at(0)).level, "fresh");
  assert.equal(freshness(GENERATED, at(11.99)).level, "fresh");
  assert.equal(freshness(GENERATED, at(12)).level, "aging");
  assert.equal(freshness(GENERATED, at(24)).level, "aging"); // exactly 24 h is not "more than 24 h"
  assert.equal(freshness(GENERATED, at(24, 1)).level, "stale");
  assert.equal(freshness(GENERATED, at(24 * 30)).level, "stale");
});

test("freshness handles an unreadable date and a clock that is behind", () => {
  assert.deepEqual(freshness("not a date", at(1)), { level: "unknown", ageMs: null });
  assert.deepEqual(freshness(undefined, at(1)), { level: "unknown", ageMs: null });
  const early = freshness(GENERATED, at(-2)); // generated_at is "in the future"
  assert.equal(early.level, "fresh");
  assert.equal(early.ageMs, 0);
});

test("freshnessText says what the data's age means, in words", () => {
  assert.deepEqual(freshnessText(GENERATED, at(2)), {
    level: "fresh", text: "Data fetched 2 hours ago (2026-11-13 00:00 UTC).",
  });
  const aging = freshnessText(GENERATED, at(13));
  assert.equal(aging.level, "aging");
  assert.match(aging.text, /^Warning: data fetched 13 hours ago \(2026-11-13 00:00 UTC\)\./);
  const stale = freshnessText(GENERATED, at(30));
  assert.equal(stale.level, "stale");
  assert.match(stale.text, /^Data may be out of date\. Fetched 1 day ago/);
  const unknown = freshnessText("nope", at(1));
  assert.equal(unknown.level, "unknown");
  assert.match(unknown.text, /can't tell when/);
});

test("failedUpdateText only speaks when the last attempt failed", () => {
  assert.equal(failedUpdateText(null), null);
  assert.equal(failedUpdateText(undefined), null);
  assert.equal(failedUpdateText({ ok: true, last_attempt: GENERATED }), null);
  assert.equal(failedUpdateText({ ok: false, last_attempt: "2026-11-13T06:17:09Z" }),
    "The last update attempt failed at 2026-11-13 06:17 UTC.");
});

// --- the archive banner -----------------------------------------------------------------------

const STOP = "2027-02-28";
const FETCHED = "2027-02-28T18:17:09Z";
const utcMs = (iso) => Date.parse(iso);

test("archiveNotice is silent up to and including the stop date (a UTC day)", () => {
  assert.equal(archiveNotice(STOP, FETCHED, utcMs("2026-11-13T00:00:00Z")), null);
  assert.equal(archiveNotice(STOP, FETCHED, utcMs("2027-02-28T00:00:00Z")), null);
  assert.equal(archiveNotice(STOP, FETCHED, utcMs("2027-02-28T23:59:59Z")), null); // still a fetching day
});

test("archiveNotice from the first UTC moment after the date says what the spec's wording says", () => {
  assert.equal(archiveNotice(STOP, FETCHED, utcMs("2027-03-01T00:00:00Z")),
    "This board is no longer updated. Archived on 2027-02-28; data shown is from 2027-02-28 18:17 UTC.");
  assert.equal(archiveNotice(STOP, "2026-11-13T02:07:32Z", utcMs("2030-06-01T12:00:00Z")),
    "This board is no longer updated. Archived on 2027-02-28; data shown is from 2026-11-13 02:07 UTC.");
});

test("archiveNotice has no end date to report for a missing or malformed value", () => {
  for (const bad of [undefined, null, "", "2027-02-30", "28/02/2027", "20270228", "2027-2-28", " 2027-02-28", 20270228, true, {}]) {
    assert.equal(archiveNotice(bad, FETCHED, utcMs("2035-01-01T00:00:00Z")), null, `${JSON.stringify(bad)} should not archive`);
  }
});

test("archiveNotice still shows the notice when the fetch time is unreadable", () => {
  assert.equal(archiveNotice(STOP, undefined, utcMs("2027-03-02T00:00:00Z")),
    "This board is no longer updated. Archived on 2027-02-28; data shown is from an unknown time.");
});

test("archiveNotice and freshness are separate: an old fetch is red on its own, and the caller picks which to show", () => {
  const now = utcMs("2027-03-05T00:00:00Z");
  assert.equal(freshness(FETCHED, now).level, "stale"); // it would be red without the archive notice
  assert.notEqual(archiveNotice(STOP, FETCHED, now), null);
});
