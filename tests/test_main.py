"""Tests for pipeline.main: file output, failure behavior, and the CLI's config errors.

Payloads come from the real fixture (or a slice of it). Nothing here uses the network.
"""
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from pipeline import main as pipeline_main
from pipeline.fetch import FetchError
from pipeline.main import main, run, write_github_output
from pipeline.parse import to_iso

ROOT = Path(__file__).parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
SAMPLE = json.loads((FIXTURES / "scout_sample.json").read_text())
MALFORMED = json.loads((FIXTURES / "scout_malformed.json").read_text())
SCORING = json.loads((ROOT / "config" / "scoring.json").read_text())
CONFIG = {"expected_scout_version": "1.3"}
T0 = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
FILES = ("latest.json", "history.json", "status.json", "scoring.json")


@pytest.fixture(autouse=True)
def no_github_output(monkeypatch):
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)


def first_rows(n):
    return {**SAMPLE, "count": str(n), "data": SAMPLE["data"][:n]}


def do_run(out, payload, now=T0):
    return run(CONFIG, SCORING, out, now, lambda: payload)


def failing(error):
    def load():
        raise error
    return load


def read(out, name):
    return json.loads((out / name).read_text())


def test_fixture_run_writes_all_four_files(tmp_path):
    assert do_run(tmp_path, SAMPLE) is True
    for name in FILES:
        assert (tmp_path / name).exists(), name
    assert not list(tmp_path.glob("*.tmp"))  # atomic writes leave no temp files behind

    latest = read(tmp_path, "latest.json")
    assert latest["schema_version"] == 1
    assert latest["generated_at"] == to_iso(T0)
    assert latest["scout_version"] == "1.3"
    assert latest["scout_count"] == 53
    names = [o["objectName"] for o in latest["objects"]]
    assert len(names) == 53 and names == sorted(names)
    obj = latest["objects"][0]
    assert set(obj) == {"objectName", "raw", "factors", "closeness_source", "gate",
                        "badges", "first_seen", "missing"}
    assert read(tmp_path, "scoring.json") == SCORING

    status = read(tmp_path, "status.json")
    assert status["ok"] is True and status["consecutive_failures"] == 0
    assert status["last_attempt"] == status["last_success"] == to_iso(T0)


def test_output_is_pretty_printed_with_sorted_keys(tmp_path):
    do_run(tmp_path, SAMPLE)
    for name in FILES:
        text = (tmp_path / name).read_text()
        assert text == json.dumps(json.loads(text), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def test_first_run_has_no_new_badges(tmp_path):
    do_run(tmp_path, SAMPLE)
    assert all("new" not in o["badges"] for o in read(tmp_path, "latest.json")["objects"])


def test_new_badge_only_on_objects_first_seen_this_run(tmp_path):
    do_run(tmp_path, first_rows(10))
    later = T0 + timedelta(hours=6)
    do_run(tmp_path, SAMPLE, now=later)
    objects = read(tmp_path, "latest.json")["objects"]
    new = [o for o in objects if "new" in o["badges"]]
    assert len(new) == 43
    assert all(o["first_seen"] == to_iso(later) for o in new)
    assert all(o["first_seen"] == to_iso(T0) for o in objects if "new" not in o["badges"])


def test_rerunning_same_data_adds_no_snapshots_and_no_new_badges(tmp_path):
    do_run(tmp_path, SAMPLE)
    do_run(tmp_path, SAMPLE, now=T0 + timedelta(hours=6))
    history = read(tmp_path, "history.json")
    assert all(len(e["snapshots"]) == 1 for e in history["objects"].values())
    assert all("new" not in o["badges"] for o in read(tmp_path, "latest.json")["objects"])


def test_empty_scout_list_is_a_success(tmp_path):
    empty = {"signature": SAMPLE["signature"], "count": "0"}
    assert do_run(tmp_path, empty) is True
    assert read(tmp_path, "latest.json")["objects"] == []
    assert read(tmp_path, "status.json")["ok"] is True


# --- Failure behavior ---------------------------------------------------------

def test_fetch_failure_leaves_data_untouched_and_counts_failures(tmp_path):
    do_run(tmp_path, SAMPLE)
    before = {name: (tmp_path / name).read_bytes() for name in ("latest.json", "history.json")}

    t1, t2 = T0 + timedelta(hours=6), T0 + timedelta(hours=12)
    assert run(CONFIG, SCORING, tmp_path, t1, failing(FetchError("HTTP 503"))) is False
    status = read(tmp_path, "status.json")
    assert status["ok"] is False and status["consecutive_failures"] == 1
    assert status["last_attempt"] == to_iso(t1)
    assert status["last_success"] == to_iso(T0)
    assert "HTTP 503" in status["message"]

    assert run(CONFIG, SCORING, tmp_path, t2, failing(FetchError("HTTP 503"))) is False
    assert read(tmp_path, "status.json")["consecutive_failures"] == 2
    for name, content in before.items():
        assert (tmp_path / name).read_bytes() == content, name

    assert do_run(tmp_path, SAMPLE, now=T0 + timedelta(hours=18)) is True
    status = read(tmp_path, "status.json")
    assert status["ok"] is True and status["consecutive_failures"] == 0
    assert status["last_success"] == to_iso(T0 + timedelta(hours=18))


def test_rejected_payload_is_a_failure_and_creates_no_data_files(tmp_path):
    assert do_run(tmp_path, MALFORMED) is False
    assert not (tmp_path / "latest.json").exists()
    assert not (tmp_path / "history.json").exists()
    status = read(tmp_path, "status.json")
    assert status["ok"] is False and status["last_success"] is None
    assert "unparseable" in status["message"]


@pytest.mark.parametrize("payload", [
    {"signature": {"version": "1.3"}, "error": "database unavailable"},
    {"count": "0"},
    [],
])
def test_scout_error_payloads_are_failures(tmp_path, payload):
    assert do_run(tmp_path, payload) is False
    assert read(tmp_path, "status.json")["ok"] is False


# --- GITHUB_OUTPUT ------------------------------------------------------------

@pytest.mark.parametrize("ok, line", [(True, "ok=true\n"), (False, "ok=false\n")])
def test_github_output(tmp_path, monkeypatch, ok, line):
    target = tmp_path / "out.txt"
    monkeypatch.setenv("GITHUB_OUTPUT", str(target))
    write_github_output(ok)
    assert target.read_text() == line


def test_github_output_is_a_noop_outside_actions(tmp_path):
    write_github_output(True)  # must not raise or create anything
    assert list(tmp_path.iterdir()) == []


# --- CLI ----------------------------------------------------------------------

def make_root(tmp_path, repo_url):
    """A throwaway repo root, so these tests keep passing once the real repo_url is set."""
    (tmp_path / "config").mkdir()
    shutil.copy(ROOT / "config" / "scoring.json", tmp_path / "config" / "scoring.json")
    app = {
        "contact": "test@example.invalid", "expected_scout_version": "1.3",
        "repo_url": repo_url, "scout_url": "https://example.invalid/scout.api",
        "user_agent_template": "FollowUpPriorityBoard/0.1 (+{repo_url}; {contact})",
    }
    (tmp_path / "config" / "app.json").write_text(json.dumps(app))
    return tmp_path


def test_real_fetch_with_placeholder_repo_url_is_a_config_error(tmp_path, monkeypatch, capsys):
    root = make_root(tmp_path, "<REPO_URL>")
    monkeypatch.setattr(pipeline_main, "fetch_scout", lambda *a, **k: pytest.fail("fetched"))
    assert main([], root=root) == 2
    assert "repo_url" in capsys.readouterr().err
    assert not (root / "site").exists()  # nothing was touched


def test_fixture_mode_never_needs_the_user_agent(tmp_path, monkeypatch):
    root = make_root(tmp_path, "<REPO_URL>")
    monkeypatch.setattr(pipeline_main, "fetch_scout", lambda *a, **k: pytest.fail("fetched"))
    assert main(["--fixture", str(FIXTURES / "scout_sample.json")], root=root) == 0
    assert read(root / "site" / "data", "status.json")["ok"] is True


def test_real_fetch_sends_the_configured_user_agent_once(tmp_path, monkeypatch):
    root = make_root(tmp_path, "https://github.com/x/y")
    calls = []

    def fake_fetch(url, user_agent):
        calls.append((url, user_agent))
        return SAMPLE

    monkeypatch.setattr(pipeline_main, "fetch_scout", fake_fetch)
    assert main([], root=root) == 0
    assert calls == [("https://example.invalid/scout.api",
                      "FollowUpPriorityBoard/0.1 (+https://github.com/x/y; test@example.invalid)")]


def test_scout_failure_through_cli_exits_zero_but_reports_not_ok(tmp_path, monkeypatch):
    root = make_root(tmp_path, "https://github.com/x/y")
    out = tmp_path / "gh_output.txt"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    load_that_fails = failing(FetchError("HTTP 500"))
    monkeypatch.setattr(pipeline_main, "fetch_scout", lambda url, user_agent: load_that_fails())
    assert main([], root=root) == 0
    assert out.read_text() == "ok=false\n"
    assert read(root / "site" / "data", "status.json")["ok"] is False
