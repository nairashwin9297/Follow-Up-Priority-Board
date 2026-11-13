// Weighted priority score. Pure functions only: no DOM, no fetch.
//
// Python already turned each raw Scout field into a 0..1 factor. All the
// browser does is take a weighted average of those, so the sliders can
// re-rank live. Factor math must never be repeated here.
//
//   priority = gate * sum(w_i * f_i) / sum(w_i)    over factors that are not null
//
// Everything below is on a 0..100 scale (the number shown in the table).

// Negative, NaN or missing weights count as 0 so a bad slider value can't produce NaN.
function cleanWeight(w) {
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Score one object. `obj` is an entry from latest.json; `weights` maps factor name -> number.
// Returns { priority, contributions, used, weightSum, gate }.
// priority is null when it can't be computed; contributions then is {}.
export function scoreObject(obj, weights) {
  const gate = obj.gate;
  // A null factor is excluded, never treated as 0: missing data must not look like "low".
  const used = Object.keys(weights).filter((name) => obj.factors[name] != null);
  const weightSum = used.reduce((sum, name) => sum + cleanWeight(weights[name]), 0);
  if (gate == null || used.length === 0 || weightSum === 0) {
    return { priority: null, contributions: {}, used, weightSum, gate };
  }
  const contributions = {};
  let priority = 0;
  for (const name of used) {
    // Each contribution is that factor's share of the priority, so the bar segments sum to it.
    contributions[name] = (100 * gate * cleanWeight(weights[name]) * obj.factors[name]) / weightSum;
    priority += contributions[name];
  }
  return { priority, contributions, used, weightSum, gate };
}

// Score and rank every object. Highest priority first; objects with no priority go last,
// and ties are broken by name so the order never jumps around between renders.
export function rankObjects(objects, weights) {
  const scored = objects.map((obj) => ({ obj, ...scoreObject(obj, weights) }));
  scored.sort((a, b) => {
    if (a.priority === null && b.priority === null) return a.obj.objectName.localeCompare(b.obj.objectName);
    if (a.priority === null) return 1;
    if (b.priority === null) return -1;
    return b.priority - a.priority || a.obj.objectName.localeCompare(b.obj.objectName);
  });
  return scored.map((row, i) => ({ ...row, rank: i + 1 }));
}

// One plain sentence naming the two biggest contributors, plus a note when the gate
// (Scout's NEO score) pulled the priority down a lot. `scoring` is data/scoring.json.
export function whyRankedHere(scored, scoring) {
  if (scored.priority === null) return "No priority score: missing data.";
  const top = Object.entries(scored.contributions)
    .filter(([, value]) => value > 0)
    // Equal contributions fall back to name order so the sentence is stable.
    .sort(([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB))
    .slice(0, 2)
    .map(([name]) => scoring.factors[name].why);
  const parts = [top.length ? `Mostly ranked by: ${top.join("; ")}.` : "No factor adds to its score."];
  if (scored.gate < scoring.gate.low_neo_score / 100) parts.push(scoring.gate.low_neo_text);
  return parts.join(" ");
}
