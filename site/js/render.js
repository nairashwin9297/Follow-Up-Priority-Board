// DOM rendering only: no scoring, no fetching, no state of its own.
//
// Everything is built with createElement + textContent, never innerHTML, so an
// object name (or any other value from the data files) can't be read as markup.
import { binLabel, formatNumber, formatSmart, niceTicks, sparklinePoints, utcLabel } from "./format.js";
import { dotRadius, nearestIndex, project } from "./sky.js";

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

// "Tablet width and wider" (48rem = 768px). Below this, the explainer and weights panels start closed so the
// table is not pushed far down a phone. Keep in step with the inline script in index.html and the CSS.
const WIDE_SCREEN = "(min-width: 48rem)";

// Built once per load. Inputs are never recreated afterwards (update() only changes
// their values), so a slider keeps keyboard focus while it is being moved.
export function buildWeightsPanel(container, scoring, { onChange, onReset }) {
  // A native <details>: open on wider screens, closed on phones. Closing it lets the table sit higher.
  const section = el("details", null, "panel weights");
  section.open = window.matchMedia(WIDE_SCREEN).matches;
  const summary = el("summary");
  const heading = el("h2", "Weights");
  heading.id = "weights-heading";
  summary.append(heading);
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
  section.append(summary, intro, list, reset, warning);
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

// Thin segmented bar: one segment per factor, the full width is 100 priority points.
// Drawn in real pixels (1 unit = 1px) so the 2px gap between segments is exactly 2px.
// The text alternative lists the numbers, so the colors are only a visual extra.
const BAR_W = 120;
const BAR_H = 8;
const BAR_GAP = 2;

function contributionBar(row, scoring) {
  const parts = scoring.factor_order
    .filter((name) => row.contributions[name] != null)
    .map((name) => `${scoring.factors[name].short} ${row.contributions[name].toFixed(1)}`);
  const text = row.priority === null
    ? "No contributions: no priority score."
    : `Contributions to priority: ${parts.join(", ")}.`;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${BAR_W} ${BAR_H}`, width: BAR_W, height: BAR_H, class: "bar", role: "img", "aria-label": text,
  });
  const title = svgEl("title", {});
  title.textContent = text;
  // One shared clip path (defined in index.html) gives the whole bar fully rounded ends.
  const group = svgEl("g", { "clip-path": "url(#bar-clip)" });
  group.append(svgEl("rect", { x: 0, y: 0, width: BAR_W, height: BAR_H, class: "bar-track" }));
  const shown = scoring.factor_order.filter((name) => row.contributions[name] > 0);
  let x = 0;
  shown.forEach((name, i) => {
    const full = (row.contributions[name] / 100) * BAR_W;
    // A 2px surface gap separates touching segments (not a border drawn around them).
    const width = i === shown.length - 1 ? full : full - BAR_GAP;
    // A sliver under a pixel can't be seen; its value is still in the text alternative.
    if (width >= 1) group.append(svgEl("rect", { x, y: 0, width, height: BAR_H, class: `seg-${name}` }));
    x += full;
  });
  svg.append(title, group);
  const cell = el("td");
  cell.append(svg);
  return cell;
}

function badgesCell(row, scoring) {
  const cell = el("td", null, "badges-cell");
  if (!row.obj.badges.length) {
    cell.textContent = "—";
    return cell;
  }
  const list = el("ul", null, "badges");
  for (const id of row.obj.badges) {
    const badge = el("li", scoring.badges[id]?.label ?? id, "badge");
    // The hover tooltip only helps mouse users, so the same text is repeated in the row detail.
    if (scoring.badges[id]?.tooltip) badge.title = scoring.badges[id].tooltip;
    list.append(badge);
  }
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

  // Only badges that need explaining get a line here. Wording stays hedged on purpose.
  const explained = obj.badges.filter((id) => scoring.badges[id]?.tooltip);
  const notes = explained.length ? el("section", null, "detail-block") : null;
  if (notes) {
    const noteList = el("dl", null, "kv score prose");
    notes.append(el("h3", "About this object's badges"), noteList);
    for (const id of explained) addTerm(noteList, scoring.badges[id].label, scoring.badges[id].tooltip);
  }

  root.append(build, ...(notes ? [notes] : []), scout, timeline);
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
  toggle.dataset.object = name; // how the sky map finds this row
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
  if (ctx.selected === name) group.classList.add("is-selected"); // the object last picked on the sky map
  group.append(main, detail);
  return group;
}

// `rows` are already ranked and sorted. ctx: { scoring, expanded: Set, selected, why(row), onOpen(name, slot) }.
export function renderRows(table, rows, ctx) {
  table.querySelectorAll("tbody").forEach((body) => body.remove());
  table.append(...rows.map((row) => rowGroup(row, ctx)));
}

// --- Priority distribution chart --------------------------------------------------------
// A column chart: one series (objects per priority range), so one color and no legend.
// Each column is its own hover/focus target with a tooltip, and a table view holds the same
// numbers, so nothing is only available by hovering.

const CHART = { w: 440, h: 230, left: 44, right: 12, top: 22, bottom: 44, maxBar: 24, radius: 4 };

// 4px rounded at the data end (top), square at the baseline.
function columnPath(x, y, w, h) {
  const r = Math.min(CHART.radius, h, w / 2);
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
}

function svgText(attrs, text) {
  const node = svgEl("text", attrs);
  node.textContent = text;
  return node;
}

const countLabel = (n) => `${n} object${n === 1 ? "" : "s"}`;

// Built once; update() redraws the bars and table, so the table's open/closed state survives.
export function buildChart(container) {
  const section = el("section", null, "panel chart-panel");
  section.setAttribute("aria-labelledby", "chart-heading");
  const heading = el("h2", "Priority distribution");
  heading.id = "chart-heading";
  const note = el("p", "How many objects fall in each priority range. It updates when you change the weights.", "panel-note");
  const summary = el("p", null, "chart-summary");

  // The canvas is the scroll content and the positioning box for the tooltip.
  const svg = svgEl("svg", {
    viewBox: `0 0 ${CHART.w} ${CHART.h}`, class: "chart", role: "group",
    "aria-label": "Priority distribution. Use the arrow keys to move between bars.",
  });
  const tooltip = el("div", null, "chart-tooltip");
  tooltip.hidden = true;
  tooltip.setAttribute("aria-hidden", "true"); // each bar's own label is what a screen reader gets
  const canvas = el("div", null, "chart-canvas");
  canvas.append(svg, tooltip);
  const figure = el("figure", null, "chart-figure");
  figure.append(canvas);

  const details = el("details", null, "chart-table");
  details.append(el("summary", "Show as a table"));
  const table = el("table");
  const caption = el("caption", "Objects per priority range");
  const headRow = el("tr");
  for (const label of ["Priority range", "Objects"]) {
    const th = el("th", label);
    th.scope = "col";
    headRow.append(th);
  }
  const thead = el("thead");
  thead.append(headRow);
  const tbody = el("tbody");
  table.append(caption, thead, tbody);
  details.append(table);

  const side = el("div", null, "viz-side");
  side.append(summary, details);
  const layout = el("div", null, "viz-layout");
  layout.append(figure, side);
  section.append(heading, note, layout);
  container.replaceChildren(section);

  let groups = [];
  let active = 0; // the one bar that is a tab stop; arrow keys move it

  function hideTip() {
    tooltip.hidden = true;
    groups.forEach((g) => g.classList.remove("is-active"));
  }

  function showTip(i, bin, last, anchorX, anchorY) {
    groups.forEach((g, j) => g.classList.toggle("is-active", j === i));
    const value = el("strong", countLabel(bin.count));
    tooltip.replaceChildren(value, el("span", `Priority ${binLabel(bin, last)}`));
    tooltip.hidden = false;
    // Convert chart units to screen pixels, then keep the tooltip inside the canvas.
    const scale = svg.getBoundingClientRect().width / CHART.w;
    const half = tooltip.offsetWidth / 2;
    const left = Math.min(Math.max(anchorX * scale, half), canvas.clientWidth - half);
    const top = anchorY * scale - tooltip.offsetHeight - 6;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(top, 0)}px`;
  }

  return {
    update(hist, summaryText) {
      summary.textContent = summaryText;
      const { bins } = hist;
      const maxCount = Math.max(...bins.map((b) => b.count));
      const ticks = niceTicks(maxCount);
      const yMax = ticks[ticks.length - 1];
      const plotW = CHART.w - CHART.left - CHART.right;
      const plotH = CHART.h - CHART.top - CHART.bottom;
      const slot = plotW / bins.length;
      const y = (v) => CHART.top + plotH - (v / yMax) * plotH;

      svg.replaceChildren();
      for (const t of ticks) { // hairline, solid, recessive; the 0 line is the baseline
        svg.append(svgEl("line", { x1: CHART.left, x2: CHART.w - CHART.right, y1: y(t), y2: y(t), class: "chart-grid" }));
        svg.append(svgText({ x: CHART.left - 6, y: y(t), class: "chart-tick", "text-anchor": "end", "dominant-baseline": "middle" }, String(t)));
      }
      bins.forEach((bin, i) => { // x labels sit on the bin edges
        svg.append(svgText({ x: CHART.left + i * slot, y: CHART.top + plotH + 16, class: "chart-tick", "text-anchor": "middle" }, String(bin.lo)));
      });
      svg.append(svgText({ x: CHART.left + plotW, y: CHART.top + plotH + 16, class: "chart-tick", "text-anchor": "middle" }, String(bins[bins.length - 1].hi)));
      svg.append(svgText({ x: CHART.left + plotW / 2, y: CHART.h - 8, class: "chart-axis-title", "text-anchor": "middle" }, "Priority (0 to 100)"));
      svg.append(svgText({ x: 12, y: CHART.top + plotH / 2, class: "chart-axis-title", "text-anchor": "middle", transform: `rotate(-90 12 ${CHART.top + plotH / 2})` }, "Objects"));

      const peak = maxCount > 0 ? bins.findIndex((b) => b.count === maxCount) : -1;
      groups = bins.map((bin, i) => {
        const last = i === bins.length - 1;
        const g = svgEl("g", {
          class: "chart-bin", role: "img", tabindex: i === active ? "0" : "-1",
          "aria-label": `${binLabel(bin, last)}: ${countLabel(bin.count)}`,
        });
        const barW = Math.min(CHART.maxBar, slot - 2);
        const barX = CHART.left + i * slot + (slot - barW) / 2;
        const barH = (bin.count / yMax) * plotH;
        const barY = y(bin.count);
        // The hit area is the whole slot, much bigger than the (thin) bar itself.
        g.append(svgEl("rect", { x: CHART.left + i * slot, y: CHART.top, width: slot, height: plotH, class: "chart-hit" }));
        if (bin.count > 0) g.append(svgEl("path", { d: columnPath(barX, barY, barW, barH), class: "chart-bar" }));
        // Only the tallest column gets a printed value; the axis and tooltip carry the rest.
        if (i === peak) g.append(svgText({ x: barX + barW / 2, y: barY - 5, class: "chart-value", "text-anchor": "middle" }, String(bin.count)));

        const show = () => showTip(i, bin, last, barX + barW / 2, barY);
        g.addEventListener("pointerenter", show);
        g.addEventListener("pointerleave", hideTip);
        g.addEventListener("focus", () => {
          active = i;
          groups.forEach((other, j) => other.setAttribute("tabindex", j === i ? "0" : "-1"));
          show();
        });
        g.addEventListener("blur", hideTip);
        g.addEventListener("keydown", (event) => {
          const target = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: bins.length - 1 }[event.key];
          if (event.key === "Escape") hideTip(); // lets a keyboard user dismiss the tooltip
          if (target === undefined) return;
          event.preventDefault();
          groups[Math.min(Math.max(target, 0), bins.length - 1)].focus();
        });
        return g;
      });
      svg.append(...groups);
      hideTip();

      tbody.replaceChildren(...bins.map((bin, i) => {
        const tr = el("tr");
        tr.append(el("th", binLabel(bin, i === bins.length - 1)), el("td", String(bin.count), "num"));
        tr.firstChild.scope = "row";
        return tr;
      }));
      if (hist.unscored) {
        const tr = el("tr");
        tr.append(el("th", "No priority score"), el("td", String(hist.unscored), "num"));
        tr.firstChild.scope = "row";
        tbody.append(tr);
      }
    },
  };
}

// --- Sky map -------------------------------------------------------------------------------
// One dot per object at its approximate RA/Dec. Dot size follows the current priority, so it
// changes as the sliders move. It is drawn in real pixels and redrawn when its box changes size,
// so the labels stay readable on a phone. Plain shapes only: no images.

const SKY = { left: 66, right: 14, top: 14, bottom: 42, minPlotWidth: 170, reach: 16 };

const dotLabel = (p) =>
  `${p.name}, ${p.priority === null ? "no priority score" : `priority ${p.priority.toFixed(1)}`}, RA ${p.raText}, Dec ${p.decText}°`;

export function buildSkyMap(container, { onSelect }) {
  const section = el("section", null, "panel sky-panel");
  section.setAttribute("aria-labelledby", "sky-heading");
  const heading = el("h2", "Sky map");
  heading.id = "sky-heading";

  const svg = svgEl("svg", {
    class: "sky", role: "group",
    "aria-label": "Sky map of the objects by right ascension and declination. Right ascension increases to the left, " +
      "as on a sky chart. Use the arrow keys to step " +
      "through the objects in priority order, and Enter to open an object's table row.",
  });
  const tooltip = el("div", null, "chart-tooltip");
  tooltip.hidden = true;
  tooltip.setAttribute("aria-hidden", "true"); // each dot has its own label for screen readers
  const canvas = el("div", null, "sky-canvas");
  canvas.append(svg, tooltip);
  const caption = el("figcaption", "Approximate sky positions (Scout gives RA to the minute, Dec to the degree).", "muted");
  const figure = el("figure", null, "sky-figure");
  figure.append(canvas, caption);

  const summary = el("p", null, "chart-summary");

  // How to read the dots, in words first, with a small picture of the sizes beside it.
  const legend = el("p", null, "sky-legend");
  const legendSvg = svgEl("svg", { viewBox: "0 0 128 24", width: 128, height: 24, "aria-hidden": "true", focusable: "false" });
  [[12, 0], [38, 50], [68, 100]].forEach(([cx, priority]) =>
    legendSvg.append(svgEl("circle", { cx, cy: 12, r: dotRadius(priority), class: "sky-dot-fill" })));
  legendSvg.append(svgEl("circle", { cx: 104, cy: 12, r: dotRadius(null), class: "sky-dot-empty" }));
  legend.append(legendSvg, el("span", "Larger dots have a higher priority. Hollow rings have no priority score."));

  const details = el("details", null, "chart-table");
  details.append(el("summary", "Show as a table"));
  const box = el("div", null, "sky-table-box");
  box.tabIndex = 0; // lets a keyboard user scroll a long table
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", "Sky map data table. Scrolls if it is long.");
  const table = el("table");
  const headRow = el("tr");
  for (const label of ["Object", "Priority", "RA", "Dec"]) {
    const th = el("th", label);
    th.scope = "col";
    headRow.append(th);
  }
  const thead = el("thead");
  thead.append(headRow);
  const tbody = el("tbody");
  table.append(el("caption", "Object positions, highest priority first"), thead, tbody);
  box.append(table);
  details.append(box);

  const side = el("div", null, "viz-side");
  side.append(summary, legend, details);
  const layout = el("div", null, "viz-layout sky-layout");
  layout.append(figure, side);
  section.append(heading, layout);
  container.replaceChildren(section);

  let data = null; // { points, unplotted, selected }
  let dots = []; // one <g> per point, in priority order
  let positions = []; // pixel position of each point, same order
  let active = 0; // the one dot that is a tab stop; arrow keys move it
  let drawnWidth = 0;

  function hideTip() {
    tooltip.hidden = true;
    dots.forEach((g) => g.classList.remove("is-active"));
  }

  function showTip(i) {
    const p = data.points[i];
    const pos = positions[i];
    dots.forEach((g, j) => g.classList.toggle("is-active", j === i));
    tooltip.replaceChildren(
      el("strong", p.name),
      el("span", p.priority === null ? "No priority score" : `Priority ${p.priority.toFixed(1)}`),
      el("span", `RA ${p.raText}, Dec ${p.decText}°`),
    );
    tooltip.hidden = false;
    const half = tooltip.offsetWidth / 2;
    tooltip.style.left = `${Math.min(Math.max(pos.x, half), canvas.clientWidth - half)}px`;
    const above = pos.y - dotRadius(p.priority) - tooltip.offsetHeight - 8;
    tooltip.style.top = `${above >= 0 ? above : pos.y + dotRadius(p.priority) + 8}px`; // flip below near the top edge
  }

  function draw() {
    if (!data) return;
    drawnWidth = canvas.clientWidth;
    const width = Math.max(drawnWidth, SKY.left + SKY.right + SKY.minPlotWidth);
    const plot = { left: SKY.left, top: SKY.top, width: width - SKY.left - SKY.right };
    plot.height = Math.max(Math.round(plot.width / 2), 150); // 15 degrees per hour of RA is a 2:1 map
    const height = plot.top + plot.height + SKY.bottom;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.replaceChildren(svgEl("rect", { x: plot.left, y: plot.top, width: plot.width, height: plot.height, class: "sky-bg" }));

    const hourLabelStep = plot.width >= 520 ? 2 : 4;
    for (let h = 0; h <= 24; h += 2) { // subtle hairline grid: every 2 hours of RA, every 30 degrees of Dec
      const { x } = project(h, 0, plot);
      svg.append(svgEl("line", { x1: x, x2: x, y1: plot.top, y2: plot.top + plot.height, class: "sky-grid" }));
      if (h % hourLabelStep === 0) {
        svg.append(svgText({ x, y: plot.top + plot.height + 16, class: "chart-tick", "text-anchor": "middle" }, `${h}h`));
      }
    }
    for (let d = -90; d <= 90; d += 30) {
      const { y } = project(0, d, plot);
      svg.append(svgEl("line", { x1: plot.left, x2: plot.left + plot.width, y1: y, y2: y, class: "sky-grid" }));
      svg.append(svgText({ x: plot.left - 6, y, class: "chart-tick", "text-anchor": "end", "dominant-baseline": "middle" }, `${d > 0 ? "+" : ""}${d}°`));
    }
    // The long label is wider than a phone-sized plot, so narrow maps get the short form.
    const raTitle = plot.width >= 420 ? "Right ascension (h), increasing to the east ←" : "Right ascension (h) ← east";
    svg.append(svgText({ x: plot.left + plot.width / 2, y: height - 6, class: "chart-axis-title", "text-anchor": "middle" }, raTitle));
    const midY = plot.top + plot.height / 2;
    svg.append(svgText({ x: 12, y: midY, class: "chart-axis-title", "text-anchor": "middle", transform: `rotate(-90 12 ${midY})` }, "Declination (degrees)"));

    positions = data.points.map((p) => project(p.ra, p.dec, plot));
    dots = data.points.map((p, i) => {
      const { x, y } = positions[i];
      const g = svgEl("g", { class: "sky-dot", role: "img", tabindex: i === active ? "0" : "-1", "aria-label": dotLabel(p) });
      g.classList.toggle("is-selected", p.name === data.selected);
      g.append(
        svgEl("circle", { cx: x, cy: y, r: dotRadius(p.priority) + 4, class: "sky-ring" }), // focus / hover / selected ring
        svgEl("circle", { cx: x, cy: y, r: dotRadius(p.priority), class: p.priority === null ? "sky-dot-empty" : "sky-dot-fill" }),
      );
      g.addEventListener("focus", () => {
        active = i;
        dots.forEach((other, j) => other.setAttribute("tabindex", j === i ? "0" : "-1"));
        showTip(i);
      });
      g.addEventListener("blur", hideTip);
      g.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(p.name);
          return;
        }
        if (event.key === "Escape") hideTip(); // lets a keyboard user dismiss the tooltip
        const last = dots.length - 1;
        const target = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: last }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        dots[Math.min(Math.max(target, 0), last)].focus();
      });
      return g;
    });
    // Big dots first, so small ones stay visible on top of them. Unscored rings go last.
    const drawOrder = data.points.map((_, i) => i).sort((a, b) => (data.points[b].priority ?? -1) - (data.points[a].priority ?? -1));
    svg.append(...drawOrder.map((i) => dots[i]));
    hideTip();
  }

  // One listener finds the nearest dot, so the pointer only has to be close, not exactly on a dot.
  const hit = (event) => {
    const box2 = svg.getBoundingClientRect();
    return nearestIndex(positions, event.clientX - box2.left, event.clientY - box2.top, SKY.reach);
  };
  svg.addEventListener("pointermove", (event) => {
    const i = data ? hit(event) : -1;
    svg.style.cursor = i === -1 ? "default" : "pointer";
    if (i === -1) hideTip();
    else showTip(i);
  });
  svg.addEventListener("pointerleave", hideTip);
  svg.addEventListener("click", (event) => {
    const i = data ? hit(event) : -1;
    if (i !== -1) onSelect(data.points[i].name);
  });
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => { if (data && canvas.clientWidth !== drawnWidth) draw(); }).observe(canvas);
  }

  return {
    update(sky, summaryText, selected) {
      data = { ...sky, selected };
      summary.textContent = summaryText;
      const rows = [...sky.points.map((p) => [p, p.raText, `${p.decText}°`]), ...sky.unplotted.map((p) => [p, "no position", "no position"])];
      tbody.replaceChildren(...rows.map(([p, ra, dec]) => {
        const tr = el("tr");
        const nameCell = el("th");
        nameCell.scope = "row";
        const open = el("button", p.name, "link-button");
        open.type = "button";
        open.addEventListener("click", () => onSelect(p.name));
        nameCell.append(open);
        tr.append(nameCell, el("td", formatNumber(p.priority, 1), "num"), el("td", ra, "num"), el("td", dec, "num"));
        return tr;
      }));
      draw();
    },
  };
}
