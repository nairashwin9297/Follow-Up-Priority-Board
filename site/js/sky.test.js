// Run with: node --test site/js
import { test } from "node:test";
import assert from "node:assert/strict";

import { dotRadius, nearestIndex, parseDecDegrees, parseRaHours, project, skyPoints, skySummary } from "./sky.js";

const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${expected}, got ${actual}`);

// --- reading Scout's RA / Dec text --------------------------------------------------

test("parseRaHours reads HH:MM (what Scout sends), and seconds if they ever appear", () => {
  near(parseRaHours("22:05"), 22 + 5 / 60);
  near(parseRaHours("05:19"), 5 + 19 / 60);
  near(parseRaHours("05:19:30"), 5 + 19 / 60 + 30 / 3600);
  assert.equal(parseRaHours("00:00"), 0);
  assert.equal(parseRaHours("24:00"), 24);
  near(parseRaHours("7"), 7);
});

test("parseRaHours rejects anything that isn't a valid right ascension", () => {
  for (const bad of ["24:01", "25:00", "-01:00", "12:60", "", "ab", "12:", ":30", "1:2:3:4", null, undefined, 12]) {
    assert.equal(parseRaHours(bad), null, `${JSON.stringify(bad)} should be rejected`);
  }
});

test("parseDecDegrees reads +DD / -DD (what Scout sends), and minutes if they ever appear", () => {
  assert.equal(parseDecDegrees("+58"), 58);
  assert.equal(parseDecDegrees("-04"), -4);
  assert.equal(parseDecDegrees("-34"), -34);
  assert.equal(parseDecDegrees("+90"), 90);
  assert.equal(parseDecDegrees("-90"), -90);
  assert.equal(parseDecDegrees("12"), 12);
  near(parseDecDegrees("+12:30"), 12.5);
  near(parseDecDegrees("-00:30"), -0.5); // the sign applies to the minutes too
});

test("parseDecDegrees gives plain 0 (not -0) and rejects invalid declinations", () => {
  assert.ok(Object.is(parseDecDegrees("-00"), 0));
  assert.ok(Object.is(parseDecDegrees("+00"), 0));
  for (const bad of ["+91", "-90:30", "-91", "", "north", "+12:75", null, undefined, 5]) {
    assert.equal(parseDecDegrees(bad), null, `${JSON.stringify(bad)} should be rejected`);
  }
});

// --- turning ranked rows into map points ------------------------------------------------

const row = (name, rank, priority, ra, dec) => ({ obj: { objectName: name, raw: { ra, dec } }, rank, priority });

test("skyPoints splits placeable from unplaceable rows and keeps priority order", () => {
  const { points, unplotted } = skyPoints([
    row("A", 1, 60, "22:05", "-04"),
    row("B", 2, 40, "bad", "+10"),
    row("C", 3, null, "05:19", "+58"),
    row("D", 4, 10, "01:00", null),
  ]);
  assert.deepEqual(points.map((p) => p.name), ["A", "C"]);
  assert.deepEqual(unplotted.map((p) => p.name), ["B", "D"]);
  near(points[0].ra, 22 + 5 / 60);
  assert.equal(points[0].dec, -4);
  assert.deepEqual([points[0].raText, points[0].decText, points[0].rank, points[0].priority], ["22:05", "-04", 1, 60]);
  assert.equal(points[1].priority, null); // an unscored object is still placed
});

// --- projection, size, hit test -------------------------------------------------------------

const PLOT = { left: 50, top: 10, width: 480, height: 240 };

test("project is laid out like a sky chart: RA 24h at the left, 0h at the right (so it increases to the left), Dec +90 on top", () => {
  assert.deepEqual(project(24, 90, PLOT), { x: 50, y: 10 }); // top left
  assert.deepEqual(project(0, -90, PLOT), { x: 530, y: 250 }); // bottom right
  assert.deepEqual(project(12, 0, PLOT), { x: 290, y: 130 }); // the middle is still the middle
  assert.deepEqual(project(6, 45, PLOT), { x: 410, y: 70 }); // 6h is three quarters of the way to the right
  assert.deepEqual(project(18, 45, PLOT), { x: 170, y: 70 }); // 18h is a quarter of the way in from the left
});

test("project: a larger RA is always further left", () => {
  let lastX = Infinity;
  for (let ra = 0; ra <= 24; ra += 1) { const { x } = project(ra, 0, PLOT); assert.ok(x < lastX); lastX = x; }
});

test("dotRadius grows with priority, is clamped, and is smallest for no priority", () => {
  assert.equal(dotRadius(null), 4);
  assert.equal(dotRadius(0), 4);
  assert.equal(dotRadius(100), 10);
  assert.equal(dotRadius(-20), 4);
  assert.equal(dotRadius(250), 10);
  assert.equal(dotRadius(25), 7); // 4 + 6 * sqrt(0.25)
  let last = 0;
  for (let p = 0; p <= 100; p += 5) { const r = dotRadius(p); assert.ok(r >= last); last = r; }
});

test("nearestIndex finds the closest position within the reach, else -1", () => {
  const spots = [{ x: 10, y: 10 }, { x: 100, y: 100 }, { x: 104, y: 100 }];
  assert.equal(nearestIndex(spots, 12, 11, 20), 0);
  assert.equal(nearestIndex(spots, 103, 100, 20), 2);
  assert.equal(nearestIndex(spots, 300, 300, 20), -1);
  assert.equal(nearestIndex(spots, 25, 10, 14), -1); // 15 away is out of reach
  assert.equal(nearestIndex(spots, 24, 10, 14), 0); // exactly at the reach counts
  assert.equal(nearestIndex([], 0, 0, 20), -1);
});

test("nearestIndex breaks an exact tie in favor of the earlier (higher-priority) position", () => {
  assert.equal(nearestIndex([{ x: 0, y: 0 }, { x: 10, y: 0 }], 5, 0, 20), 0);
});

// --- the text summary -------------------------------------------------------------------------

test("skySummary describes the map in words", () => {
  const sky = skyPoints([row("A", 1, 65.64, "22:05", "-04"), row("B", 2, 40, "05:19", "+58"), row("C", 3, 12, "01:00", "+10")]);
  assert.equal(skySummary(sky),
    "Approximate positions of 3 objects: 2 in the northern sky (declination above 0°) and 1 in the southern. " +
    "Highest priority on the map: A (65.6) at RA 22:05, Dec -04°.");
});

test("skySummary mentions unplaced objects, objects listed at 0°, and objects with no priority", () => {
  const withGap = skySummary(skyPoints([row("A", 1, 50, "10:00", "+00"), row("B", 2, 20, "x", "y"), row("C", 3, 10, "x", "y")]));
  assert.match(withGap, /Approximate positions of 1 object: 0 in the northern sky .* and 0 in the southern, and 1 listed at 0°\./);
  assert.match(withGap, /2 objects have no usable position and are not shown\.$/);
  assert.match(skySummary(skyPoints([row("A", 1, 50, "10:00", "+10"), row("B", 2, 20, "x", "y")])), /1 object has no usable position and is not shown\.$/);
  assert.match(skySummary(skyPoints([row("A", 1, null, "10:00", "+10")])), /None of the plotted objects has a priority score\.$/);
});

test("skySummary skips an unscored object when naming the highest priority, and handles empty maps", () => {
  const sky = skyPoints([row("A", 1, null, "10:00", "+10"), row("B", 2, 30, "11:00", "-20")]);
  assert.match(skySummary(sky), /Highest priority on the map: B \(30\.0\) at RA 11:00, Dec -20°\./);
  assert.equal(skySummary({ points: [], unplotted: [] }), "There are no objects to plot.");
  assert.equal(skySummary(skyPoints([row("A", 1, 1, "x", "y"), row("B", 2, 2, "x", "y")])), "None of the 2 objects has a usable position.");
});
