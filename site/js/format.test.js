// Run with: node --test site/js
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  failedUpdateText, formatNumber, formatSmart, freshness, freshnessText, relativeTime, utcLabel,
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
