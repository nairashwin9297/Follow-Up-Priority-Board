// DOM rendering only: no scoring, no fetching, no state of its own.
//
// Everything is built with createElement + textContent, never innerHTML, so an
// object name (or any other value from the data files) can't be read as markup.
import { formatNumber, formatSmart, sparklinePoints, utcLabel } from "./format.js";

const SVG_NS = "http://www.w3.org/2000/svg";
// Scout's own page for one object (its router uses #/object/<designation>).
const SCOUT_OBJECT_URL = "https://cneos.jpl.nasa.gov/scout/#/object/";
const SCOUT_INTRO_URL = "https://cneos.jpl.nasa.gov/scout/intro.html";

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function externalLink(text, href) {
  const link = el("a", text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.append(el("span", " (opens in a new tab)", "visually-hidden"));
  return link;
}

// A term/description pair; `content` can mix strings and nodes.
function addTerm(list, term, ...content) {
  const dd = el("dd");
  dd.append(...content);
  list.append(el("dt", term), dd);
}

// --- Banners and messages -----------------------------------------------------------

// Show a banner line, or hide it when there is nothing to say. `level` styles it;
// the text itself always says what is going on, so color is never the only cue.
export function showNote(node, text, level) {
  node.hidden = !text;
  node.textContent = text || "";
  if (level) node.dataset.level = level;
  else delete node.dataset.level;
}

// Loading, empty and error states share one box. Errors are announced at once (alert);
// the others politely (status).
export function showMessage(container, { kind, title, text, onRetry }) {
  const box = el("div", null, `message message-${kind}`);
  box.setAttribute("role", kind === "error" ? "alert" : "status");
  box.append(el("p", title, "message-title"), el("p", text));
  if (onRetry) {
    const button = el("button", "Try again");
    button.type = "button";
    button.addEventListener("click", onRetry);
    box.append(button);
  }
  container.replaceChildren(box);
}

// --- Weights panel ------------------------------------------------------------------

// Built once per load. Inputs are never recreated afterwards (update() only changes
// their values), so a slider keeps keyboard focus while it is being moved.
export function buildWeightsPanel(container, scoring, { onChange, onReset }) {
  const section = el("section", null, "panel");
  section.setAttribute("aria-labelledby", "weights-heading");
  const heading = el("h2", "Weights");
  heading.id = "weights-heading";
  const intro = el("p", "Move a slider to change how much each factor counts. Weights are scaled to add up to 100%. " +
    "An object that lacks a factor is scored on the factors it has.", "panel-note");

  const list = el("div", null, "weights-list");
  const controls = {};
  for (const name of scoring.factor_order) {
    const row = el("div", null, "weight-row");
    const swatch = el("span", null, `swatch seg-${name}`);
    swatch.setAttribute("aria-hidden", "true");
    const label = el("label", scoring.factors[name].label);
    label.htmlFor = `weight-${name}`;
    const input = el("input");
    Object.assign(input, { type: "range", id: `weight-${name}`, min: "0", max: "1", step: "0.05" });
    input.addEventListener("input", () => onChange(name, Number(input.value)));
    const value = el("output", null, "weight-value");
    value.setAttribute("for", input.id);
    value.setAttribute("aria-live", "off"); // the slider's own value text is read instead
    const share = el("span", null, "weight-share");
    row.append(swatch, label, input, value, share);
    list.append(row);
    controls[name] = { input, value, share };
  }

  const reset = el("button", "Reset to defaults");
  reset.type = "button";
  reset.addEventListener("click", onReset);
  const warning = el("p", null, "panel-note");
  section.append(heading, intro, list, reset, warning);
  container.replaceChildren(section);

  return {
    update(weights, shares) {
      for (const name of scoring.factor_order) {
        const { input, value, share } = controls[name];
        input.value = String(weights[name]);
        const percent = shares[name] === null ? "—" : `${Math.round(shares[name] * 100)}%`;
        value.textContent = weights[name].toFixed(2);
        share.textContent = `= ${percent} of total`;
        input.setAttribute("aria-valuetext", `${weights[name].toFixed(2)}, ${percent} of the total`);
      }
      const allZero = Object.values(shares).every((s) => s === null);
      warning.textContent = allZero ? "All weights are zero, so no priority can be calculated." : "";
    },
  };
}

// --- Table --------------------------------------------------------------------------

// `sort` is the direction of the first click on that column; columns without it can't be sorted.
export const COLUMNS = [
  { key: "rank", label: "Rank", sort: "asc", num: true },
  { key: "object", label: "Object", sort: "asc" },
  { key: "priority", label: "Priority", sort: "desc", num: true },
  { key: "bar", label: "Contribution by factor" },
  { key: "badges", label: "Badges" },
  { key: "nObs", label: "Observations", sort: "desc", num: true },
  { key: "arc", label: "Arc (hours)", sort: "desc", num: true },
  { key: "uncP1", label: "Position uncertainty in 1 day (arcmin)", sort: "desc", num: true },
  { key: "neoScore", label: "Scout NEO score", sort: "desc", num: true },
  { key: "Vmag", label: "V magnitude", sort: "desc", num: true },
  { key: "why", label: "Why ranked here" },
];

// Creates the table frame once. The header (and its sort buttons) is never rebuilt, so a
// focused sort button keeps focus while rows re-render. Returns handles for app.js.
export function buildTable(container, { onSort }) {
  const table = el("table");
  const caption = el("caption");
  const headRow = el("tr");
  const sortable = {};
  for (const col of COLUMNS) {
    const th = el("th");
    th.scope = "col";
    if (col.num) th.classList.add("num");
    if (col.sort) {
      th.setAttribute("aria-sort", "none");
      const button = el("button", col.label, "sort-button");
      button.type = "button";
      const indicator = el("span", null, "sort-indicator");
      indicator.setAttribute("aria-hidden", "true"); // aria-sort already tells screen readers
      button.append(" ", indicator);
      button.addEventListener("click", () => onSort(col.key));
      th.append(button);
      sortable[col.key] = { th, indicator };
    } else {
      th.textContent = col.label;
    }
    headRow.append(th);
  }
  const thead = el("thead");
  thead.append(headRow);
  table.append(caption, thead);

  // A focusable scroll region lets keyboard users scroll the table sideways on small screens.
  const wrap = el("div", null, "table-wrap");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "Ranked objects. Scroll sideways on narrow screens.");
  wrap.append(table);
  container.replaceChildren(wrap);

  return {
    table,
    setCaption(text) {
      caption.textContent = text;
    },
    setSort(key, dir) {
      for (const [name, { th, indicator }] of Object.entries(sortable)) {
        const active = name === key;
        th.setAttribute("aria-sort", active ? (dir === "asc" ? "ascending" : "descending") : "none");
        indicator.textContent = active ? (dir === "asc" ? "▲" : "▼") : "";
      }
    },
  };
}

function numberCell(text) {
  return el("td", text, "num");
}

function priorityCell(row) {
  const cell = numberCell(formatNumber(row.priority, 1));
  // Missing factors are left out of the score, not guessed, so say so in the row.
  if (row.obj.missing.length) {
    const flag = el("span", "missing data", "flag");
    flag.title = `Left out of the score: ${row.obj.missing.join(", ")}`;
    cell.append(" ", flag);
  }
  return cell;
}

// Stacked bar: one segment per factor, widths in priority points (the full bar is 100).
// The text alternative lists the numbers, so the colors are only a visual extra.
function contributionBar(row, scoring) {
  const parts = scoring.factor_order
    .filter((name) => row.contributions[name] != null)
    .map((name) => `${scoring.factors[name].short} ${row.contributions[name].toFixed(1)}`);
  const text = row.priority === null
    ? "No contributions: no priority score."
    : `Contributions to priority: ${parts.join(", ")}.`;

  const svg = svgEl("svg", {
    viewBox: "0 0 100 10", width: "120", height: "12", class: "bar", role: "img",
    "aria-label": text, preserveAspectRatio: "none",
  });
  svg.append(svgEl("title", {}), svgEl("rect", { x: 0, y: 0, width: 100, height: 10, class: "bar-track" }));
  svg.firstChild.textContent = text;
  let x = 0;
  for (const name of scoring.factor_order) {
    const width = row.contributions[name];
    if (!width) continue;
    svg.append(svgEl("rect", { x, y: 0, width, height: 10, class: `seg-${name}` }));
    x += width;
  }
  const cell = el("td");
  cell.append(svg);
  return cell;
}

function badgesCell(row, scoring) {
  const cell = el("td");
  if (!row.obj.badges.length) {
    cell.textContent = "—";
    return cell;
  }
  const list = el("ul", null, "badges");
  for (const id of row.obj.badges) list.append(el("li", scoring.badges[id]?.label ?? id, "badge"));
  cell.append(list);
  return cell;
}

// --- Row detail -----------------------------------------------------------------------

const UNITS = { arc: "h", unc: "arcmin", uncP1: "arcmin", caDist: "LD", moid: "au", elong: "°", Vmag: "mag", H: "mag" };
const CLOSENESS_SOURCE = {
  caDist: "close-approach distance (caDist)",
  moid: "MOID converted to lunar distances (caDist is not available)",
};

function rawValue(key, value) {
  if (value == null) return "—";
  return UNITS[key] ? `${value} ${UNITS[key]}` : String(value);
}

// Returns { node, slot }. The history slot is filled later by fillHistory(), because
// history.json is only fetched when a row is opened.
function buildDetail(row, scoring) {
  const { obj } = row;
  const root = el("div", null, "detail");

  const build = el("section", null, "detail-block");
  const buildList = el("dl", null, "kv score");
  build.append(el("h3", "How this score was built"), buildList);
  for (const name of scoring.factor_order) {
    const value = obj.factors[name];
    const points = row.contributions[name];
    addTerm(buildList, scoring.factors[name].label, value == null
      ? "missing data: left out of the score"
      : `${value.toFixed(2)}${points == null ? "" : ` → adds ${points.toFixed(1)} points`}`);
  }
  addTerm(buildList, "Gate (Scout NEO score ÷ 100)", obj.gate == null ? "missing data" : obj.gate.toFixed(2));
  addTerm(buildList, "Closeness is based on", CLOSENESS_SOURCE[obj.closeness_source] ?? "neither caDist nor MOID is available");

  const scout = el("section", null, "detail-block");
  const scoutList = el("dl", null, "kv");
  scout.append(el("h3", "Scout's values (as received)"), scoutList);
  for (const [key, value] of Object.entries(obj.raw)) {
    if (key === "objectName") continue;
    if (key === "rating") {
      addTerm(scoutList, "Scout rating", rawValue(key, value), " ", externalLink("What is this?", SCOUT_INTRO_URL),
        el("span", " Shown for reference; not used in the score.", "muted"));
    } else {
      addTerm(scoutList, key, rawValue(key, value));
    }
  }

  const timeline = el("section", null, "detail-block");
  const timeList = el("dl", null, "kv");
  const slot = el("div", null, "history-slot");
  timeline.append(el("h3", "History"), timeList, slot);
  addTerm(timeList, "First seen", utcLabel(obj.first_seen));

  const links = el("p", null, "detail-links");
  links.append(externalLink("Open this object on Scout", SCOUT_OBJECT_URL + encodeURIComponent(obj.objectName)));
  timeline.append(links);

  root.append(build, scout, timeline);
  return { node: root, slot };
}

function sparkline(snapshots) {
  const values = snapshots.map((s) => s.uncP1).filter((v) => v != null);
  if (values.length < 2) {
    return el("p", `Only ${values.length} snapshot${values.length === 1 ? "" : "s"} with an uncertainty value so far, ` +
      "so there is no trend to draw yet.", "muted");
  }
  const width = 160;
  const height = 44;
  const points = sparklinePoints(values, width, height);
  const text = `Position uncertainty in 1 day over ${values.length} snapshots: from ${formatSmart(values[0])} ` +
    `to ${formatSmart(values[values.length - 1])} arcmin.`;
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "sparkline", role: "img", "aria-label": text });
  svg.append(
    svgEl("polyline", { points: points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "), fill: "none" }),
    svgEl("circle", { cx: points.at(-1)[0].toFixed(1), cy: points.at(-1)[1].toFixed(1), r: 3 }),
  );
  const figure = el("figure", null, "sparkline-figure");
  figure.append(svg, el("figcaption", `Position uncertainty (uncP1) by snapshot, scaled to this object's own range. ${text}`, "muted"));
  return figure;
}

// state: { status: "loading" | "error" | "ready", entry } where entry is history.json's record for the object.
export function fillHistory(slot, { status, entry }) {
  slot.replaceChildren();
  if (status === "loading") {
    slot.append(el("p", "Loading history…", "muted"));
  } else if (status === "error") {
    slot.append(el("p", "History couldn't be loaded. Close and reopen this row to try again.", "muted"));
  } else if (!entry) {
    slot.append(el("p", "No history recorded for this object yet.", "muted"));
  } else {
    const list = el("dl", null, "kv");
    // An object that leaves Scout's list is only "last seen"; we can't know why it left.
    addTerm(list, "Last seen in Scout's list", utcLabel(entry.last_seen));
    addTerm(list, "Snapshots recorded", String(entry.snapshots.length));
    slot.append(list, sparkline(entry.snapshots));
  }
}

// --- Rows -----------------------------------------------------------------------------

function rowGroup(row, ctx) {
  const { scoring, expanded } = ctx;
  const name = row.obj.objectName;
  const raw = row.obj.raw;
  const detailId = `detail-${encodeURIComponent(name)}`;
  const isOpen = expanded.has(name);

  const main = el("tr", null, "row-main");
  const objectCell = el("th");
  objectCell.scope = "row";
  const toggle = el("button", name, "row-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(isOpen));
  toggle.setAttribute("aria-controls", detailId);
  objectCell.append(toggle);

  const why = el("td", ctx.why(row), "why");
  const rank = numberCell(String(row.rank));
  rank.classList.add("rank");
  main.append(
    rank, objectCell, priorityCell(row), contributionBar(row, scoring), badgesCell(row, scoring),
    numberCell(formatNumber(raw.nObs)), numberCell(formatSmart(raw.arc)), numberCell(formatSmart(raw.uncP1)),
    numberCell(formatNumber(raw.neoScore)), numberCell(formatNumber(raw.Vmag, 1)), why,
  );

  const detail = el("tr", null, "row-detail");
  detail.id = detailId;
  detail.hidden = !isOpen;
  const detailCell = el("td");
  detailCell.colSpan = COLUMNS.length;
  const { node, slot } = buildDetail(row, scoring);
  detailCell.append(node);
  detail.append(detailCell);

  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    detail.hidden = !open;
    if (open) {
      expanded.add(name);
      ctx.onOpen(name, slot);
    } else {
      expanded.delete(name);
    }
  });
  if (isOpen) ctx.onOpen(name, slot);

  // Each object gets its own <tbody>, so zebra striping covers the row and its detail together.
  const group = el("tbody");
  group.append(main, detail);
  return group;
}

// `rows` are already ranked and sorted. ctx: { scoring, expanded: Set, why(row), onOpen(name, slot) }.
export function renderRows(table, rows, ctx) {
  table.querySelectorAll("tbody").forEach((body) => body.remove());
  table.append(...rows.map((row) => rowGroup(row, ctx)));
}
