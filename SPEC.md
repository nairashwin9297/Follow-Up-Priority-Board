# SPEC — Follow-Up Priority Board

You are helping me build a small portfolio project. I must be able to explain every
line, so favor small, readable code over cleverness. Read this whole file before
writing anything. Work in the phases at the end and STOP after each phase.

## 1. What it is

A static web page that ranks the unconfirmed near-Earth object (NEO) candidates
currently listed by NASA/JPL's Scout system by an illustrative "triage priority":
how much each one seems to need follow-up observations before its position becomes
too uncertain to recover.

- This is a demo of transparent, tunable triage logic. It is NOT an official method
  and NOT a replacement for real tools. The README must cite prior art:
  JPL CNEOS Scout (https://cneos.jpl.nasa.gov/scout/intro.html) and
  NEOfixer from the Catalina Sky Survey (https://neofixer.arizona.edu/faq/how-does-neofixer-assign-priority),
  and explain how this project differs (simpler, no per-site cost model, fully
  explainable, keeps its own snapshot history).
- No AI or LLM calls inside the app.

## 2. Architecture (decided — do not change without asking)

- `pipeline/`: Python 3.12 script. Fetches Scout once, validates, parses, computes
  normalized factors, updates history, writes JSON into `site/data/`.
- GitHub Actions: runs the pipeline on a schedule, commits changed JSON, deploys
  `site/` to GitHub Pages in the SAME workflow.
- `site/`: plain HTML + CSS + JavaScript ES modules. NO framework, NO Tailwind,
  NO build step, NO npm dependencies. The browser applies the weights so sliders work live.
- No server, no database server, no FastAPI in production.
- The browser NEVER calls the Scout API (JPL fair-use policy forbids embedding the
  API in a website). The browser only reads our own JSON files.

### Dependencies
- Python: standard library only for the pipeline (`urllib.request`, `json`,
  `datetime`, `math`). `pytest` for tests only (in `requirements-dev.txt`).
- JavaScript: none. Tests use Node's built-in `node --test`.
- Ask me before adding ANY dependency.

## 3. Repository layout

```
.
├── SPEC.md
├── README.md
├── requirements-dev.txt          # pytest
├── config/
│   └── scoring.json              # thresholds, default weights, badge rules (single source of truth)
├── pipeline/
│   ├── __init__.py
│   ├── fetch.py                  # HTTP GET with User-Agent, timeout, limited retry
│   ├── parse.py                  # validation + string->number conversion + null handling
│   ├── factors.py                # normalized 0..1 factors + badges
│   ├── history.py                # snapshot history, 30-day retention
│   └── main.py                   # orchestrates; writes site/data/*.json
├── tests/
│   ├── fixtures/scout_sample.json   # a REAL Scout response I will provide
│   ├── fixtures/scout_malformed.json
│   ├── test_parse.py
│   ├── test_factors.py
│   └── test_history.py
├── site/
│   ├── index.html
│   ├── styles.css
│   ├── js/app.js                 # load data, state, events
│   ├── js/score.js               # pure weighted-sum + "why ranked here" (no DOM)
│   ├── js/render.js              # DOM rendering only
│   ├── js/score.test.js          # node --test
│   └── data/                     # latest.json, history.json, status.json, scoring.json (copied)
└── .github/workflows/update-and-deploy.yml
```

## 4. Scout data facts (verified by me from a real response and the docs)

- Endpoint: `GET https://ssd-api.jpl.nasa.gov/scout.api` (summary mode, no params).
- Docs: https://ssd-api.jpl.nasa.gov/doc/scout.html and fair use: https://ssd-api.jpl.nasa.gov/doc/
- Top level: `signature` {`version`, `source`}, `count` (STRING), `data` (array, may be absent if count is "0").
- Most numeric fields are STRINGS; some are `null`. Parse defensively.
- Fields used:
  - `objectName` (temporary designation, string)
  - `nObs` (count of observations)
  - `arc` (observed arc, hours)
  - `unc`, `uncP1` (1-sigma plane-of-sky uncertainty now / ~1 day later, arcmin; range ~0.01 to ~4800)
  - `neoScore`, `phaScore` (Scout likelihood scores, 0–100)
  - `caDist` (close-approach distance, lunar distances; null in ~half of rows)
  - `moid` (au)
  - `Vmag`, `H`, `elong` (deg), `rate`, `ra` ("HH:MM"), `dec` ("+DD")
  - `lastRun`, `tEphem`: UTC strings like "2026-11-12 10:48" or with seconds, no "T"/"Z". Parse as UTC explicitly.
  - `rating`: Scout's own impact-chance category (0–4). Store and display as "Scout rating" with a link to Scout's explanation; do NOT use in scoring.
  - Ignore `ieoScore`, `vInf`, `geocentricScore`, `tisserandScore`, `rmsN` for scoring (keep raw values in output).
- HTTP: 500 = database unavailable, 503 = overloaded. 200 can still carry an error or zero results — validate the payload.
- Scout's own caveats: objects are unconfirmed and some may not be real; H, MOID, close-approach values are very uncertain for short arcs; scores identify interesting objects, not rigorous probabilities.

### Fair-use requirements (must implement)
- Exactly ONE request per run, no parallel requests.
- `User-Agent: FollowUpPriorityBoard/0.1 (+https://github.com/<GITHUB_USER>/<REPO>; <CONTACT_EMAIL>)` — read from env vars `UA_REPO_URL` and `UA_CONTACT`; fail loudly if missing.
- Timeout 30 s. At most 2 retries with backoff (10 s, then 30 s), only on network errors / 500 / 503.
- If `signature.version` differs from the expected value in config, log a WARNING (do not abort).

## 5. Scoring (illustrative heuristic)

All numbers below live in `config/scoring.json`. Python computes the normalized
factors; the browser only computes the weighted sum. Never duplicate factor math in JS.

Helper: `clamp01(x)`; `lognorm(x, lo, hi) = clamp01((log10(x) - log10(lo)) / (log10(hi) - log10(lo)))`.

Factors (each 0..1, or `null` if inputs are missing):

1. `urgency` = 0.7 * lognorm(uncP1, 1, 600) + 0.3 * growth,
   where growth = clamp01(log10(uncP1 / unc) / 1) (i.e. 10x growth in a day = 1).
   If unc is missing or 0, use only the first term (renormalized).
2. `sparse` (few observations / short arc) =
   0.5 * (1 - clamp01((nObs - 3) / (20 - 3))) + 0.5 * (1 - lognorm(arc_hours, 0.5, 72)).
3. `pha` = phaScore / 100. Label in UI: "PHA likelihood (Scout)". Never "impact risk".
4. `observability` = 0.6 * clamp01((24 - Vmag) / (24 - 18)) + 0.4 * clamp01((elong - 45) / (135 - 45)).
   Label: "Brightness & sky position (coarse, not site-specific)".
5. `closeness`: if caDist present: 1 - lognorm(caDist_LD, 0.1, 100), source = "caDist".
   Else if moid present: convert moid_au * 389.17 to LD, same formula, source = "moid".
   Record `closeness_source`; the UI must show which one was used.

Gate: `gate = neoScore / 100`.

Priority (computed in browser, `score.js`):
```
priority = gate * Σ(w_i * f_i) / Σ(w_i)   over factors where f_i is not null
```
Default weights: urgency 0.30, sparse 0.20, pha 0.20, observability 0.15, closeness 0.15.
Missing factors are excluded (not imputed) and flagged in the row as "missing data".
Result displayed 0–100, one decimal.

Contributions for the stacked bar: `gate * w_i * f_i / Σw`. "Why ranked here" = a
plain sentence built from the two largest contributions, e.g.
"Mostly ranked by: position uncertainty growing fast; few observations."
Also note when the gate pulled it down a lot (neoScore < 50): "Scout rates it unlikely to be a NEO."

### Badges (thresholds in config)
- "Orbit uncertain": uncP1 > 60 arcmin
- "Few observations": nObs < 6 OR arc < 2 h
- "Close approach": caDist < 5 LD (only when caDist present)
- "Stale Scout run": lastRun older than 24 h at fetch time
- "New": first seen in the most recent snapshot

## 6. Output JSON (document the schema in README)

`site/data/latest.json`
```
{ "schema_version": 1, "generated_at": "ISO-8601 Z", "scout_version": "1.3",
  "scout_count": 48, "objects": [ { "objectName": ..., "raw": {...all parsed fields...},
  "factors": {"urgency": 0.82, ...}, "closeness_source": "caDist",
  "gate": 1.0, "badges": ["orbit_uncertain"], "first_seen": "...", "missing": ["closeness"] } ] }
```
`site/data/history.json`: per object `{first_seen, last_seen, snapshots: [{t, nObs, arc, unc, uncP1, neoScore}]}`.
Append a snapshot only when (objectName, lastRun) is new. Drop objects whose last_seen is older than 30 days.
Wording rule: an object no longer listed is "last seen", never "confirmed" or "resolved".

`site/data/status.json`: `{last_attempt, last_success, ok, consecutive_failures, message}`.

`site/data/scoring.json`: copy of `config/scoring.json` (weights, labels) for the browser.

### Failure behavior
- If fetch or validation fails: do NOT touch latest.json or history.json. Update status.json
  (ok=false, increment consecutive_failures). The pipeline exits 0 but writes `ok=false`
  to `$GITHUB_OUTPUT`; the workflow fails a final step after deploying, so the run shows red
  AND the page can show "last update attempt failed".
- Validation: top-level dict, `data` is a list when count > 0, each row has objectName,
  numeric parse failures become null (counted and logged). Reject the whole payload if more than
  50% of rows are unparseable, or if count is a non-number.
- Write files atomically (write temp file, then rename). Pretty-print with sorted keys so diffs are readable.

## 7. GitHub Actions workflow

File: `.github/workflows/update-and-deploy.yml`

- Triggers: `schedule: cron "17 */6 * * *"` (off-minute on purpose), `workflow_dispatch`,
  `push` to `main` on paths `site/**`, `pipeline/**`, `config/**`.
- On `push`, skip the Scout fetch (just redeploy). Fetch only on schedule / dispatch.
- Workflow-level `permissions: contents: read`. `concurrency: { group: pages, cancel-in-progress: false }`.
- Job `update` (`timeout-minutes: 10`, `permissions: contents: write`):
  checkout → setup Python 3.12 → run tests (`pytest -q`, `node --test site/js`) → run pipeline
  (env UA_REPO_URL, UA_CONTACT from repo variables) → if `git status --porcelain site/data` is non-empty,
  commit as github-actions[bot] with message "data: Scout snapshot <UTC time>", `git pull --rebase`, push
  → `actions/configure-pages` → `actions/upload-pages-artifact` with path `site`.
  IMPORTANT: upload the artifact from this same job, after the commit, so the deployed files include the
  new data. (A separate job's checkout would get the triggering commit, not the new one.)
- Job `deploy` (`needs: update`, permissions `pages: write`, `id-token: write`, `contents: read`,
  environment `github-pages`): `actions/deploy-pages`.
- Final step/job: fail if pipeline output ok == false.
- Use the current major versions of the official actions; tell me which versions you used.
- Commits made with GITHUB_TOKEN do not trigger other workflows; that is fine because deploy is in the same workflow.

## 8. Front end

Visual direction: dark-first "observatory control room": dense, monospace numbers,
restrained accent color. Also support light mode via `prefers-color-scheme`.
All colors as CSS custom properties. Meet WCAG 2.1 AA contrast in both themes.

Layout (responsive; table scrolls horizontally inside its own container on small screens):
1. Header: title, data freshness banner, honesty line.
2. Collapsible "What am I looking at?" panel (native `<details>`), plain English, ~150 words:
   what NEOCP/Scout candidates are, why follow-up matters, what the score is and isn't.
3. Weights panel: one labeled `<input type="range">` per factor (0–1, step 0.05), live value readout,
   "Reset to defaults" button. Weights renormalize automatically; show the effective percentages.
4. Ranked table: native `<table>` with `<caption>`, `<th scope>`; sortable columns via buttons in headers
   with `aria-sort`. Columns: rank, object, priority, stacked contribution bar (inline SVG with a text
   alternative), badges, nObs, arc (h), uncP1 (arcmin), neoScore, Vmag, "why ranked here".
5. Expandable row detail (button with `aria-expanded`): all raw fields, factor values, closeness source,
   Scout rating, first/last seen, a small inline-SVG sparkline of uncP1 over snapshots, link to the object on Scout.
6. One compact chart: distribution of priorities or uncP1 vs nObs (inline SVG, with a text summary).
7. Footer honesty notes (see below).

States: loading (skeleton or text), empty (Scout lists no objects), error (JSON failed to load —
show message and retry button), stale.

Freshness banner (computed in the browser from `generated_at` vs current time, so it works even if the pipeline is dead):
- < 12 h: neutral "Data fetched <relative time> (<UTC time>)"
- 12–24 h: amber warning; > 24 h: red "Data may be out of date".
- If status.json `ok` is false: "The last update attempt failed at <time>."

Accessibility: full keyboard use, visible focus styles, labels on every control, `aria-live="polite"`
region announcing re-sorts and weight changes ("Ranking updated"), respects `prefers-reduced-motion`,
no information by color alone (badges have text).

Fetch data with `fetch('data/latest.json', { cache: 'no-cache' })`. Load history.json lazily, only when a detail row opens.

### Required honesty text (shown on the page)
- "Data: NASA/JPL CNEOS Scout. Fetched <time>." Text credit only; no NASA/JPL logos.
- "All objects are unconfirmed candidates; some may not be real."
- "Priority is an illustrative heuristic I designed, not an official method."
- "Not affiliated with NASA, JPL, the Minor Planet Center, or the Smithsonian."
- Never describe an object as "safe", "dangerous", or "a threat".
- "Snapshots every ~6 hours; objects listed only briefly between snapshots are missed."

## 9. Tests

- `test_parse.py`: string→number, nulls, bad numbers become null, UTC parsing of "YYYY-MM-DD HH:MM" and
  with seconds, malformed payload rejected, count "0" with no data handled.
- `test_factors.py`: each factor at boundaries and mid-range, caDist vs moid fallback and unit conversion,
  missing inputs → null, badges.
- `test_history.py`: new (objectName, lastRun) appends, duplicate doesn't, 30-day pruning, first_seen stable.
- `score.test.js`: weighted sum, renormalization, excluded null factors, gate, top-two "why" text.

## 10. README (write last)

Sections: what it is (2 sentences + screenshot placeholder), live link placeholder, how the score works
(formula table), limitations, prior art (Scout, NEOfixer) and how this differs, architecture diagram
(Mermaid), JSON schema, setup steps (Settings → Pages → Source: GitHub Actions; repo variables
UA_REPO_URL and UA_CONTACT; how to run locally; how to disable the schedule), "How this was built"
(built with Claude Code, reviewed and tested by me; a short "corrections I made to AI output" list that
I will fill in — leave it as a TODO, do not invent entries), credits and disclaimers.

## 11. Working rules for you (Claude Code)

- Work in phases. After each phase: run the tests, list the files you changed, and explain each file in
  plain language (what it does, why it's designed that way, any tradeoff). Then STOP and wait for me.
- Keep files short. Add comments that explain WHY, not what.
- Do not add features, dependencies, or files beyond this spec without asking.
- If anything in this spec is ambiguous or seems wrong, ask before guessing.
- Never fabricate Scout data. Use only the fixture I provide or a real fetch I approve.
- Don't push to GitHub or change repo settings; I'll do that.

## 12. Phases

1. Scaffold + `config/scoring.json` + `pipeline/parse.py` + tests against the real fixture.
2. `factors.py`, `history.py`, `fetch.py`, `main.py` + tests. Run the pipeline locally once against the
   fixture (add a `--fixture PATH` flag) and show me a sample of latest.json.
3. Front end, minimal: load data, render table with priority, freshness banner, states. `score.js` + its tests.
4. Weights sliders, stacked bars, "why ranked here", badges, detail rows, sparkline.
5. Workflow YAML. Explain every step and permission.
6. Accessibility pass (keyboard walk-through, contrast check of every color pair, screen-reader labels),
   one chart, "What am I looking at?" text, honesty notes.
7. README.

If time runs short, skip in this order: the chart, the sparkline, light theme, "New" badge.
Never skip: tests, failure handling, freshness banner, honesty notes, keyboard and label accessibility.
