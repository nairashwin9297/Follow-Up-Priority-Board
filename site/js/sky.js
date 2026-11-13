// Pure helpers for the sky map: reading Scout's RA/Dec text, projecting onto the plot, sizing the
// dots, finding the dot nearest the pointer, and writing the text summary. No DOM here, so
// `node --test` can check them.
//
// Scout's summary gives RA as "HH:MM" and Dec as "+DD" (RA to the minute, Dec to the degree), so
// positions on the map are approximate by nature.

// "05:19" / "05:19:30" / "+58" / "-04" / "+12:30" -> { sign, value }, or null if it isn't that shape.
function parseSexagesimal(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^([+-])?(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?(?::(\d+(?:\.\d+)?))?$/);
  if (!match) return null;
  const [, sign, degrees, minutes = "0", seconds = "0"] = match;
  if (Number(minutes) >= 60 || Number(seconds) >= 60) return null;
  return { sign: sign === "-" ? -1 : 1, value: Number(degrees) + Number(minutes) / 60 + Number(seconds) / 3600 };
}

// Right ascension in hours (0 to 24), or null.
export function parseRaHours(text) {
  const parsed = parseSexagesimal(text);
  if (!parsed || parsed.sign < 0 || parsed.value > 24) return null;
  return parsed.value;
}

// Declination in degrees (-90 to 90), or null. The sign applies to the minutes too ("-00:30" is -0.5).
export function parseDecDegrees(text) {
  const parsed = parseSexagesimal(text);
  if (!parsed || parsed.value > 90) return null;
  return parsed.sign * parsed.value || 0; // `|| 0` turns -0 into 0
}

// Split ranked rows (from rankObjects) into objects we can place and objects we can't.
// Both lists keep the rows' priority order.
export function skyPoints(rows) {
  const points = [];
  const unplotted = [];
  for (const row of rows) {
    const { ra, dec } = row.obj.raw;
    const raHours = parseRaHours(ra);
    const decDegrees = parseDecDegrees(dec);
    const base = { name: row.obj.objectName, priority: row.priority, rank: row.rank };
    if (raHours === null || decDegrees === null) unplotted.push(base);
    else points.push({ ...base, ra: raHours, dec: decDegrees, raText: ra, decText: dec });
  }
  return { points, unplotted };
}

// Plain equirectangular projection laid out like a sky chart: RA increases to the LEFT (24h at the left
// edge, 0h at the right, so east is on the left); Dec +90 at the top.
// `plot` is the plotting rectangle in pixels: { left, top, width, height }.
export function project(ra, dec, plot) {
  return { x: plot.left + (1 - ra / 24) * plot.width, y: plot.top + ((90 - dec) / 180) * plot.height };
}

// Dot radius in pixels. Area grows with priority (so the radius follows its square root).
// An object with no priority gets the smallest size (the map draws it as a hollow ring).
export function dotRadius(priority, min = 4, max = 10) {
  if (priority === null) return min;
  const share = Math.min(Math.max(priority, 0), 100) / 100;
  return min + (max - min) * Math.sqrt(share);
}

// Index of the position closest to (x, y), or -1 if none is within maxDistance. On a tie the
// earlier one wins, which is the higher-priority object. This is the hit test for the map:
// the pointer only has to be near a dot, not exactly on it.
export function nearestIndex(positions, x, y, maxDistance) {
  let best = -1;
  let bestDistance = Infinity;
  positions.forEach((p, i) => {
    const distance = Math.hypot(p.x - x, p.y - y);
    if (distance < bestDistance) { // strictly less, so a tie keeps the earlier one
      best = i;
      bestDistance = distance;
    }
  });
  return bestDistance <= maxDistance ? best : -1;
}

const objects = (n) => `${n} object${n === 1 ? "" : "s"}`;

// The map's text summary: the same picture in words, for anyone who can't see the dots.
export function skySummary({ points, unplotted }) {
  const total = points.length + unplotted.length;
  if (total === 0) return "There are no objects to plot.";
  if (points.length === 0) return `None of the ${objects(total)} has a usable position.`;
  const north = points.filter((p) => p.dec > 0).length;
  const south = points.filter((p) => p.dec < 0).length;
  const equator = points.length - north - south;
  const parts = [
    `Approximate positions of ${objects(points.length)}: ${north} in the northern sky (declination above 0°) ` +
      `and ${south} in the southern${equator ? `, and ${equator} listed at 0°` : ""}.`,
  ];
  const top = points.find((p) => p.priority !== null); // points are in priority order
  parts.push(top
    ? `Highest priority on the map: ${top.name} (${top.priority.toFixed(1)}) at RA ${top.raText}, Dec ${top.decText}°.`
    : "None of the plotted objects has a priority score.");
  if (unplotted.length) {
    parts.push(`${objects(unplotted.length)} ${unplotted.length === 1 ? "has" : "have"} no usable position and ` +
      `${unplotted.length === 1 ? "is" : "are"} not shown.`);
  }
  return parts.join(" ");
}
