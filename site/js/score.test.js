// Run with: node --test site/js
// Expected numbers are worked out by hand from the formula in SPEC.md section 5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { rankObjects, scoreObject, whyRankedHere } from "./score.js";

const SCORING = JSON.parse(readFileSync(new URL("../../config/scoring.json", import.meta.url)));
const W = SCORING.weights; // urgency .30, sparse .20, pha .20, observability .15, closeness .15

// Floating-point sums are not exact, so compare with a tiny tolerance.
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);

function obj(name, factors, gate = 1) {
  const all = { urgency: null, sparse: null, pha: null, observability: null, closeness: null };
  return { objectName: name, gate, factors: { ...all, ...factors } };
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

test("why explains a missing priority and an all-zero one", () => {
  assert.equal(whyRankedHere(scoreObject(obj("A", {}), W), SCORING), "No priority score: missing data.");
  const zero = whyRankedHere(scoreObject(obj("A", ONES, 0), W), SCORING);
  assert.equal(zero, "No factor adds to its score. Scout rates it unlikely to be a NEO.");
});

// --- the JS side and config/scoring.json must agree -------------------------------

test("every weight has a label and a why phrase, and the weights sum to 1", () => {
  for (const name of Object.keys(W)) {
    assert.ok(SCORING.factors[name].label, `${name} has no label`);
    assert.ok(SCORING.factors[name].why, `${name} has no why phrase`);
  }
  near(Object.values(W).reduce((a, b) => a + b, 0), 1);
});
