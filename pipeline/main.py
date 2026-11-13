"""Run the pipeline: fetch -> validate -> score -> update history -> write JSON.

    python -m pipeline.main                      # real fetch (one request)
    python -m pipeline.main --fixture FILE.json  # no network, no User-Agent needed

A Scout failure exits 0 but records ok=false, so CI can deploy first and then
turn red. A config error exits 2 before any file is touched.
"""
import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from .factors import compute_object
from .fetch import ConfigError, FetchError, build_user_agent, fetch_scout
from .history import empty_history, update_history
from .parse import ValidationError, parse_payload, to_iso

log = logging.getLogger(__name__)
REPO_ROOT = Path(__file__).resolve().parent.parent


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def write_json_atomic(path, data):
    """Write to a temp file, then rename, so a crash never leaves half a file."""
    # sort_keys + indent keep git diffs readable; allow_nan=False refuses invalid JSON.
    text = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text + "\n")
    os.replace(tmp, path)  # atomic on the same filesystem


def write_github_output(ok):
    """Tell the workflow whether the fetch worked (no-op outside GitHub Actions)."""
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            f.write(f"ok={'true' if ok else 'false'}\n")


def run(config, scoring, out_dir, now, load_payload):
    """One pipeline run. Returns True on success, False if Scout data was rejected."""
    out_dir.mkdir(parents=True, exist_ok=True)
    old_status = read_json(out_dir / "status.json", {})
    status = {
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

    history = read_json(out_dir / "history.json", empty_history())
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
        "generated_at": generated_at,
        "scout_version": parsed["scout_version"],
        "scout_count": parsed["scout_count"],
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


def main(argv=None, root=REPO_ROOT):
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

    now = datetime.now(timezone.utc).replace(microsecond=0)
    ok = run(config, scoring, root / "site" / "data", now, load_payload)
    write_github_output(ok)
    return 0


if __name__ == "__main__":
    sys.exit(main())
