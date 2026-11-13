"""Run the pipeline: fetch -> validate -> score -> update history -> write JSON.

    python -m pipeline.main                      # real fetch (one request)
    python -m pipeline.main --fixture FILE.json  # no network, no User-Agent needed

A Scout failure exits 0 but records ok=false, so CI can deploy first and then
turn red. A config error exits 2 before any file is touched.

Once the UTC date in config/app.json "stop_fetching_after" has passed, a real run does nothing: it
makes no request, changes no file (so the workflow has nothing to commit) and exits 0.
"""
import argparse
import json
import logging
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from .factors import compute_object
from .fetch import ConfigError, FetchError, build_user_agent, fetch_scout
from .history import empty_history, update_history
from .parse import ValidationError, parse_payload, to_iso

log = logging.getLogger(__name__)
REPO_ROOT = Path(__file__).resolve().parent.parent


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def read_same_source(path, source, default):
    """Read a state file, but only trust it if the same kind of run wrote it.

    Demo (fixture) data must never leak into real history or status, so a file
    from the other source, or an old one with no source field, counts as absent.
    """
    data = read_json(path, None)
    if data is None:
        return default
    if data.get("source") != source:
        log.warning("Ignoring %s: written by source %r but this run is %r; "
                    "treating it as empty (first run)", path.name, data.get("source"), source)
        return default
    return data


def write_json_atomic(path, data):
    """Write to a temp file, then rename, so a crash never leaves half a file."""
    # sort_keys + indent keep git diffs readable; allow_nan=False refuses invalid JSON.
    text = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text + "\n")
    os.replace(tmp, path)  # atomic on the same filesystem


def write_github_output(ok, skipped=False):
    """Tell the workflow whether the fetch worked (no-op outside GitHub Actions).

    A skipped run (past the stop date) reports ok=true: nothing went wrong, so the workflow stays green.
    """
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            f.write(f"ok={'true' if ok else 'false'}\n")
            if skipped:
                f.write("skipped=true\n")


def write_step_summary(text):
    """Put a line on the workflow run's summary page, so a skipped run explains itself (no-op locally)."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write(text + "\n")


def parse_stop_date(config):
    """The last UTC day on which a real run may fetch, or None when there is no end date.

    Strictly YYYY-MM-DD: Python's date.fromisoformat would also accept forms like 20270228.
    A bad value is a config error (the run fails loudly) rather than quietly meaning "no end date".
    """
    value = config.get("stop_fetching_after")
    if value is None:
        return None
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        try:
            return date.fromisoformat(value)
        except ValueError:  # the right shape but not a real day, like 2027-02-30
            pass
    raise ConfigError(f"config/app.json: stop_fetching_after must be a date like 2027-02-28 (got {value!r})")


def is_archived(stop_date, now):
    """True once the UTC date is later than the stop date. The stop date itself is still a fetching day."""
    return stop_date is not None and now.astimezone(timezone.utc).date() > stop_date


def run(config, scoring, out_dir, now, load_payload, source):
    """One pipeline run. Returns True on success, False if Scout data was rejected.

    source is "scout" for a real fetch or "fixture" for a saved test file.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    old_status = read_same_source(out_dir / "status.json", source, {})
    status = {
        "source": source,
        "last_attempt": to_iso(now),
        "last_success": old_status.get("last_success"),
    }

    try:
        parsed = parse_payload(load_payload(), config["expected_scout_version"])
    except (FetchError, ValidationError) as e:
        # latest.json and history.json stay exactly as they were; only status changes.
        log.error("Update failed: %s", e)
        status.update(ok=False, message=str(e),
                      consecutive_failures=old_status.get("consecutive_failures", 0) + 1)
        write_json_atomic(out_dir / "status.json", status)
        return False

    history = read_same_source(out_dir / "history.json", source, empty_history(source))
    # With no history every object would look "new", which says nothing useful.
    first_run = not history["objects"]
    history = update_history(history, parsed["objects"], now)

    generated_at = to_iso(now)
    objects = []
    # Sorted by name (not Scout's order) so unchanged data gives unchanged diffs.
    for raw in sorted(parsed["objects"], key=lambda o: o["objectName"]):
        obj = compute_object(raw, scoring, now)
        first_seen = history["objects"][raw["objectName"]]["first_seen"]
        obj["first_seen"] = first_seen
        if not first_run and first_seen == generated_at:
            obj["badges"].append("new")
        objects.append(obj)

    latest = {
        "schema_version": 1,
        "source": source,
        "generated_at": generated_at,
        "scout_version": parsed["scout_version"],
        "scout_count": parsed["scout_count"],
        # The page reads this (it can't read config/app.json) to show its "archived" banner after the date,
        # even once this pipeline has stopped running.
        "stop_fetching_after": config.get("stop_fetching_after"),
        "objects": objects,
    }
    write_json_atomic(out_dir / "history.json", history)
    write_json_atomic(out_dir / "latest.json", latest)
    write_json_atomic(out_dir / "scoring.json", scoring)
    status.update(ok=True, consecutive_failures=0, last_success=generated_at,
                  message=f"OK: {len(objects)} objects")
    write_json_atomic(out_dir / "status.json", status)
    log.info("Wrote %d objects (parse stats: %s)", len(objects), parsed["stats"])
    return True


def main(argv=None, root=REPO_ROOT, now=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fixture", type=Path,
                        help="read this JSON file instead of calling Scout")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    config = read_json(root / "config" / "app.json", None)
    scoring = read_json(root / "config" / "scoring.json", None)
    if config is None or scoring is None:
        print("config error: config/app.json or config/scoring.json is missing", file=sys.stderr)
        return 2

    try:
        stop_date = parse_stop_date(config)
    except ConfigError as e:
        print(f"config error: {e}", file=sys.stderr)
        return 2
    now = now or datetime.now(timezone.utc).replace(microsecond=0)

    # Past the stop date a real run (scheduled or manual) does nothing at all: no request, no file written,
    # so there is nothing to commit. Fixture runs are local demos and ignore the date.
    if not args.fixture and is_archived(stop_date, now):
        message = (f"Scout fetch skipped: the stop date ({stop_date.isoformat()}) has passed, so this board is "
                   "archived. No data files were changed. To resume, move stop_fetching_after in config/app.json.")
        log.info(message)
        write_step_summary(message)
        write_github_output(True, skipped=True)
        return 0

    if args.fixture:
        def load_payload():
            return json.loads(args.fixture.read_text())
    else:
        try:
            user_agent = build_user_agent(config)
        except ConfigError as e:
            print(f"config error: {e}", file=sys.stderr)
            return 2

        def load_payload():
            return fetch_scout(config["scout_url"], user_agent)

    source = "fixture" if args.fixture else "scout"
    ok = run(config, scoring, root / "site" / "data", now, load_payload, source)
    write_github_output(ok)
    return 0


if __name__ == "__main__":
    sys.exit(main())
