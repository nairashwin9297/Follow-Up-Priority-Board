// Run with: node --test site/js
// Expected numbers are worked out by hand from the formula in SPEC.md section 5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { effectiveShares, rankObjects, scoreObject, sortRows, whyRankedHere } from "./score.js";

const SCORING = JSON.parse(readFileSync(new URL("../../config/scoring.json", import.meta.url)));
const W = SCORING.weights; // urgency .30, sparse .20, pha .20, observability .15, closeness .15

// Floating-point sums are not exact, so compare with a tiny tolerance.
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);

function obj(name, factors, gate = 1, raw = {}) {
  const all = { urgency: null, sparse: null, pha: null, observability: null, closeness: null };
  return { objectName: name, gate, factors: { ...all, ...factors }, raw };
}
const ONES = { urgency: 1, sparse: 1, pha: 1, observability: 1, closeness: 1 };

// --- weighted sum ---------------------------------------------------------------

test("a single factor at 1 scores its normalized weight", () => {
  const r = scoreObject(obj("A", { ...ONES, sparse: 0, pha: 0, observability: 0, closeness: 0 }), W);
  near(r.priority, 30); // only urgency (0.30 of 1.00) contributes
});

test("weighted sum over all five factors", () => {
  const f = { urgency: 0.5, sparse: 1, pha: 0, observability: 0.2, closeness: 0.4 };
  // .30*.5 + .20*1 + .20*0 + .15*.2 + .15*.4 = .15 + .20 + 0 + .03 + .06 = .44
  near(scoreObject(obj("A", f), W).priority, 44);
});

test("weights are renormalized, so scaling them all changes nothing", () => {
  const f = { urgency: 0.5, sparse: 1, pha: 0, observability: 0.2, closeness: 0.4 };
  const doubled = Object.fromEntries(Object.entries(W).map(([k, v]) => [k, v * 2]));
  near(scoreObject(obj("A", f), doubled).priority, scoreObject(obj("A", f), W).priority);
});

test("all factors at 1 with gate 1 gives exactly 100", () => {
  near(scoreObject(obj("A", ONES), W).priority, 100);
});

// --- null factors are excluded, not imputed -------------------------------------

test("a null factor is left out of both the sum and the weight total", () => {
  const r = scoreObject(obj("A", { ...ONES, closeness: null }), W);
  near(r.priority, 100); // 0.85/0.85. Treating null as 0 would wrongly give 85.
  assert.deepEqual(r.used, ["urgency", "sparse", "pha", "observability"]);
  near(r.weightSum, 0.85);
});

test("a factor of 0 is NOT null: it counts and pulls the score down", () => {
  near(scoreObject(obj("A", { ...ONES, closeness: 0 }), W).priority, 85);
});

test("priority is null when every factor is null", () => {
  const r = scoreObject(obj("A", {}), W);
  assert.equal(r.priority, null);
  assert.deepEqual(r.contributions, {});
});

test("priority is null when the present factors all have zero weight", () => {
  const weights = { ...W, urgency: 0, sparse: 0, pha: 0, observability: 0 };
  assert.equal(scoreObject(obj("A", { urgency: 1, sparse: 1 }), weights).priority, null);
});

test("negative and NaN weights count as zero", () => {
  const weights = { ...W, urgency: -5, pha: NaN };
  const r = scoreObject(obj("A", ONES), weights);
  near(r.priority, 100);
  assert.equal(r.contributions.urgency, 0);
  assert.equal(r.contributions.pha, 0);
});

// --- gate -----------------------------------------------------------------------

test("the gate scales the whole priority", () => {
  const f = { urgency: 1, sparse: 1, pha: 1, observability: 1, closeness: 1 };
  near(scoreObject(obj("A", f, 0.5), W).priority, 50);
  near(scoreObject(obj("A", f, 0), W).priority, 0);
});

test("priority is null when the gate is missing", () => {
  assert.equal(scoreObject(obj("A", ONES, null), W).priority, null);
});

// --- contributions --------------------------------------------------------------

test("contributions sum to the priority and only cover used factors", () => {
  const o = obj("A", { urgency: 0.5, sparse: 1, pha: null, observability: 0.2, closeness: 0.4 }, 0.8);
  const r = scoreObject(o, W);
  assert.deepEqual(Object.keys(r.contributions).sort(), ["closeness", "observability", "sparse", "urgency"]);
  near(Object.values(r.contributions).reduce((a, b) => a + b, 0), r.priority);
  // sparse: 100 * 0.8 * 0.20 * 1 / 0.80
  near(r.contributions.sparse, 20);
});

// --- ranking --------------------------------------------------------------------

test("rankObjects sorts high to low, puts null last, breaks ties by name", () => {
  const rows = rankObjects(
    [
      obj("C-null", {}),
      obj("B-tie", { ...ONES }, 0.5),
      obj("A-top", { ...ONES }),
      obj("A-tie", { ...ONES }, 0.5),
      obj("D-null", {}),
    ],
    W,
  );
  assert.deepEqual(rows.map((r) => r.obj.objectName), ["A-top", "A-tie", "B-tie", "C-null", "D-null"]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4, 5]);
});

test("rankObjects does not modify its input", () => {
  const input = [obj("B", { pha: 0.1 }), obj("A", { pha: 0.9 })];
  rankObjects(input, W);
  assert.deepEqual(input.map((o) => o.objectName), ["B", "A"]);
});

// --- effective weight shares ----------------------------------------------------

test("effectiveShares add up to 1 and ignore overall scale", () => {
  const shares = effectiveShares(W);
  near(shares.urgency, 0.3);
  near(Object.values(shares).reduce((a, b) => a + b, 0), 1);
  near(effectiveShares({ ...W, urgency: 0.6, sparse: 0.4, pha: 0.4, observability: 0.3, closeness: 0.3 }).urgency, 0.3);
});

test("effectiveShares are all null when every weight is zero, and bad weights count as zero", () => {
  const zero = effectiveShares({ urgency: 0, sparse: 0, pha: -1, observability: NaN, closeness: 0 });
  assert.deepEqual(Object.values(zero), [null, null, null, null, null]);
  assert.equal(effectiveShares({ urgency: 1, sparse: -3 }).sparse, 0);
});

// --- sorting --------------------------------------------------------------------

const ranked = () =>
  rankObjects(
    [
      obj("B", { pha: 0.2 }, 1, { nObs: 5, arc: 1, uncP1: 10, neoScore: 90, Vmag: 20 }),
      obj("A", { pha: 0.9 }, 1, { nObs: 12, arc: null, uncP1: 300, neoScore: 40, Vmag: 22 }),
      obj("C", { pha: 0.5 }, 1, { nObs: null, arc: 8, uncP1: 40, neoScore: 70, Vmag: null }),
    ],
    W,
  );
const names = (rows) => rows.map((r) => r.obj.objectName);

test("sortRows by priority rank, both directions", () => {
  assert.deepEqual(names(sortRows(ranked(), "rank", "asc")), ["A", "C", "B"]);
  assert.deepEqual(names(sortRows(ranked(), "rank", "desc")), ["B", "C", "A"]);
  assert.deepEqual(names(sortRows(ranked(), "priority", "desc")), ["A", "C", "B"]);
});

test("sortRows by name and by raw numeric columns", () => {
  assert.deepEqual(names(sortRows(ranked(), "object", "asc")), ["A", "B", "C"]);
  assert.deepEqual(names(sortRows(ranked(), "object", "desc")), ["C", "B", "A"]);
  assert.deepEqual(names(sortRows(ranked(), "uncP1", "desc")), ["A", "C", "B"]);
  assert.deepEqual(names(sortRows(ranked(), "neoScore", "asc")), ["A", "C", "B"]);
});

test("sortRows keeps empty values last in both directions", () => {
  assert.deepEqual(names(sortRows(ranked(), "nObs", "desc")), ["A", "B", "C"]);
  assert.deepEqual(names(sortRows(ranked(), "nObs", "asc")), ["B", "A", "C"]);
  assert.deepEqual(names(sortRows(ranked(), "arc", "asc")), ["B", "C", "A"]);
  assert.deepEqual(names(sortRows(ranked(), "Vmag", "desc")), ["A", "B", "C"]);
});

test("sortRows never renumbers ranks, breaks ties by rank, and leaves its input alone", () => {
  const rows = ranked();
  const byName = sortRows(rows, "object", "desc");
  // Priority order is A, C, B, so C, B, A carry ranks 2, 3, 1: sorting never renumbers.
  assert.deepEqual(byName.map((r) => r.rank), [2, 3, 1]);
  const tied = rankObjects([obj("X", { pha: 1 }, 1, { nObs: 4 }), obj("Y", { pha: 0.5 }, 1, { nObs: 4 })], W);
  assert.deepEqual(names(sortRows(tied, "nObs", "desc")), ["X", "Y"]);
  assert.deepEqual(names(rows), ["A", "C", "B"]);
});

test("sortRows rejects an unknown column", () => {
  assert.throws(() => sortRows(ranked(), "bogus", "asc"), /Unknown sort key/);
});

// --- "why ranked here" ----------------------------------------------------------

test("why names the two largest contributions, largest first", () => {
  // contributions: urgency .30*1 = 30, sparse .20*.5 = 10, pha .20*.75 = 15 -> urgency, pha
  const o = obj("A", { urgency: 1, sparse: 0.5, pha: 0.75 }, 1);
  const text = whyRankedHere(scoreObject(o, W), SCORING);
  assert.equal(text, "Mostly ranked by: position uncertainty growing fast; high PHA likelihood (Scout).");
});

test("why uses one phrase when only one factor contributes", () => {
  const o = obj("A", { urgency: 1, sparse: 0, pha: 0, observability: 0, closeness: 0 });
  assert.equal(whyRankedHere(scoreObject(o, W), SCORING),
    "Mostly ranked by: position uncertainty growing fast.");
});

test("why adds the gate note below 50 but not at 50", () => {
  const f = { urgency: 1, sparse: 1, pha: 1, observability: 1, closeness: 1 };
  const low = whyRankedHere(scoreObject(obj("A", f, 0.49), W), SCORING);
  assert.ok(low.endsWith(" Scout rates it unlikely to be a NEO."), low);
  const edge = whyRankedHere(scoreObject(obj("A", f, 0.5), W), SCORING);
  assert.ok(!edge.includes("unlikely"), edge);
});

test("why tells slider-zeroed weights apart from missing data", () => {
  const onlyUrgency = { urgency: 0.8 };
  const zeroed = { ...W, urgency: 0, sparse: 0, pha: 0, observability: 0, closeness: 0 };
  assert.equal(whyRankedHere(scoreObject(obj("A", onlyUrgency), zeroed), SCORING),
    "No priority score: every weight for its available factors is zero.");
  assert.equal(whyRankedHere(scoreObject(obj("A", onlyUrgency, null), W), SCORING),
    "No priority score: missing data.");
});

test("why explains a missing priority and an all-zero one", () => {
  assert.equal(whyRankedHere(scoreObject(obj("A", {}), W), SCORING), "No priority score: missing data.");
  const zero = whyRankedHere(scoreObject(obj("A", ONES, 0), W), SCORING);
  assert.equal(zero, "No factor adds to its score. Scout rates it unlikely to be a NEO.");
});

// --- the JS side and config/scoring.json must agree -------------------------------

test("every weight has a label, short name and why phrase, is in factor_order, and the weights sum to 1", () => {
  assert.deepEqual([...SCORING.factor_order].sort(), Object.keys(W).sort());
  for (const name of Object.keys(W)) {
    assert.ok(SCORING.factors[name].label, `${name} has no label`);
    assert.ok(SCORING.factors[name].short, `${name} has no short name`);
    assert.ok(SCORING.factors[name].why, `${name} has no why phrase`);
  }
  near(Object.values(W).reduce((a, b) => a + b, 0), 1);
});
