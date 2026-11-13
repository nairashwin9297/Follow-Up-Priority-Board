// DOM rendering only: no scoring, no fetching, no state.
//
// Everything is built with createElement + textContent, never innerHTML, so an
// object name (or any other value from the data files) can't be read as markup.
import { formatNumber, formatSmart } from "./format.js";

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

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

const HEADERS = [
  "Rank", "Object", "Priority", "Observations", "Arc (hours)",
  "Position uncertainty in 1 day (arcmin)", "Scout NEO score", "V magnitude",
];

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

function tableRow(row) {
  const raw = row.obj.raw;
  const tr = el("tr");
  tr.append(
    numberCell(String(row.rank)),
    el("th", row.obj.objectName, "object"),
    priorityCell(row),
    numberCell(formatNumber(raw.nObs)),
    numberCell(formatSmart(raw.arc)),
    numberCell(formatSmart(raw.uncP1)),
    numberCell(formatNumber(raw.neoScore)),
    numberCell(formatNumber(raw.Vmag, 1)),
  );
  tr.firstElementChild.className = "num rank";
  tr.children[1].scope = "row";
  return tr;
}

// `rows` come from rankObjects() in score.js, already sorted.
export function renderTable(container, rows) {
  const table = el("table");
  table.append(el("caption", `Unconfirmed NEO candidates, ranked by illustrative follow-up priority (${rows.length} objects)`));

  const headRow = el("tr");
  for (const label of HEADERS) {
    const th = el("th", label);
    th.scope = "col";
    headRow.append(th);
  }
  table.append(el("thead"), el("tbody"));
  table.tHead.append(headRow);
  table.tBodies[0].append(...rows.map(tableRow));

  // A focusable scroll region lets keyboard users scroll the table sideways on small screens.
  const wrap = el("div", null, "table-wrap");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "Ranked objects. Scroll sideways on narrow screens.");
  wrap.append(table);
  container.replaceChildren(wrap);
}
