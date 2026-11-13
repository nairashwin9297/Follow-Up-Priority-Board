"""Tests for pipeline.main: file output, failure behavior, and the CLI's config errors.

Payloads come from the real fixture (or a slice of it). Nothing here uses the network.
"""
import json
import shutil
import subprocess
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from pipeline import main as pipeline_main
from pipeline.fetch import ConfigError, FetchError
from pipeline.main import (
    is_archived, main, parse_stop_date, run, write_github_output, write_step_summary,
)
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


def do_run(out, payload, now=T0, source="fixture"):
    return run(CONFIG, SCORING, out, now, lambda: payload, source)


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


# --- Source: demo data must never pass as real -------------------------------------

def test_every_output_file_records_its_source(tmp_path):
    for source in ("fixture", "scout"):
        out = tmp_path / source
        do_run(out, SAMPLE, source=source)
        for name in ("latest.json", "history.json", "status.json"):
            assert read(out, name)["source"] == source, (source, name)


def test_a_real_run_ignores_fixture_history_and_says_so(tmp_path, caplog):
    do_run(tmp_path, SAMPLE, source="fixture")
    later = T0 + timedelta(hours=6)
    with caplog.at_level("WARNING"):
        assert do_run(tmp_path, first_rows(10), now=later, source="scout") is True
    assert "history.json" in caplog.text and "'fixture'" in caplog.text

    history = read(tmp_path, "history.json")
    assert history["source"] == "scout"
    assert len(history["objects"]) == 10  # the other 43 fixture objects did not carry over
    assert all(e["first_seen"] == to_iso(later) for e in history["objects"].values())
    # Treated as a first run, so nothing is "new".
    assert all("new" not in o["badges"] for o in read(tmp_path, "latest.json")["objects"])


def test_history_with_no_source_field_is_not_trusted_by_a_real_run(tmp_path):
    do_run(tmp_path, SAMPLE, source="scout")
    history = read(tmp_path, "history.json")
    del history["source"]  # what files written before this field existed look like
    (tmp_path / "history.json").write_text(json.dumps(history))
    do_run(tmp_path, first_rows(10), now=T0 + timedelta(hours=6), source="scout")
    assert len(read(tmp_path, "history.json")["objects"]) == 10


def test_a_fixture_run_does_not_mix_into_real_history(tmp_path):
    do_run(tmp_path, SAMPLE, source="scout")
    do_run(tmp_path, first_rows(10), now=T0 + timedelta(hours=6), source="fixture")
    history = read(tmp_path, "history.json")
    assert history["source"] == "fixture" and len(history["objects"]) == 10


def test_same_source_history_still_accumulates(tmp_path):
    do_run(tmp_path, first_rows(10), source="scout")
    do_run(tmp_path, SAMPLE, now=T0 + timedelta(hours=6), source="scout")
    assert len(read(tmp_path, "history.json")["objects"]) == 53


def test_failed_real_run_does_not_inherit_fixture_status(tmp_path):
    do_run(tmp_path, SAMPLE, source="fixture")
    latest_before = (tmp_path / "latest.json").read_bytes()
    t1 = T0 + timedelta(hours=6)
    assert run(CONFIG, SCORING, tmp_path, t1, failing(FetchError("HTTP 503")), "scout") is False
    status = read(tmp_path, "status.json")
    assert status["source"] == "scout"
    assert status["consecutive_failures"] == 1
    assert status["last_success"] is None  # the fixture "success" is not a real one
    assert (tmp_path / "latest.json").read_bytes() == latest_before  # data untouched, still labeled fixture


# --- Failure behavior ---------------------------------------------------------

def test_fetch_failure_leaves_data_untouched_and_counts_failures(tmp_path):
    do_run(tmp_path, SAMPLE)
    before = {name: (tmp_path / name).read_bytes() for name in ("latest.json", "history.json")}

    t1, t2 = T0 + timedelta(hours=6), T0 + timedelta(hours=12)
    assert run(CONFIG, SCORING, tmp_path, t1, failing(FetchError("HTTP 503")), "fixture") is False
    status = read(tmp_path, "status.json")
    assert status["ok"] is False and status["consecutive_failures"] == 1
    assert status["last_attempt"] == to_iso(t1)
    assert status["last_success"] == to_iso(T0)
    assert "HTTP 503" in status["message"]

    assert run(CONFIG, SCORING, tmp_path, t2, failing(FetchError("HTTP 503")), "fixture") is False
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

def make_root(tmp_path, repo_url, **extra):
    """A throwaway repo root, so these tests keep passing once the real repo_url is set.

    Extra keyword arguments become extra keys in its config/app.json (for example stop_fetching_after).
    """
    (tmp_path / "config").mkdir()
    shutil.copy(ROOT / "config" / "scoring.json", tmp_path / "config" / "scoring.json")
    app = {
        "contact": "test@example.invalid", "expected_scout_version": "1.3",
        "repo_url": repo_url, "scout_url": "https://example.invalid/scout.api",
        "user_agent_template": "FollowUpPriorityBoard/0.1 (+{repo_url}; {contact})",
    }
    app.update(extra)
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
    out = root / "site" / "data"
    assert read(out, "status.json")["ok"] is True
    assert read(out, "latest.json")["source"] == "fixture"


def test_real_fetch_sends_the_configured_user_agent_once(tmp_path, monkeypatch):
    root = make_root(tmp_path, "https://github.com/x/y")
    calls = []

    def fake_fetch(url, user_agent):
        calls.append((url, user_agent))
        return SAMPLE

    monkeypatch.setattr(pipeline_main, "fetch_scout", fake_fetch)
    assert main([], root=root) == 0
    assert read(root / "site" / "data", "latest.json")["source"] == "scout"
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


# --- The end date (stop_fetching_after) -----------------------------------------------------------

STOP = "2027-02-28"
REAL_URL = "https://github.com/x/y"
BEFORE = datetime(2027, 2, 1, 6, 17, tzinfo=timezone.utc)
LAST_DAY = datetime(2027, 2, 28, 23, 59, 59, tzinfo=timezone.utc)  # the stop date itself is still a fetching day
NEXT_DAY = datetime(2027, 3, 1, 0, 0, 0, tzinfo=timezone.utc)  # the first moment that is skipped


def fake_scout(monkeypatch):
    """Swap the real fetch for one that returns the real fixture and records every call."""
    calls = []

    def fetch(url, user_agent):
        calls.append(url)
        return SAMPLE

    monkeypatch.setattr(pipeline_main, "fetch_scout", fetch)
    return calls


def data_snapshot(root):
    out = root / "site" / "data"
    return {p.name: p.read_bytes() for p in sorted(out.iterdir())} if out.exists() else None


@pytest.mark.parametrize("now", [BEFORE, LAST_DAY])
def test_up_to_and_including_the_stop_date_the_fetch_runs(tmp_path, monkeypatch, now):
    root = make_root(tmp_path, REAL_URL, stop_fetching_after=STOP)
    calls = fake_scout(monkeypatch)
    assert main([], root=root, now=now) == 0
    assert len(calls) == 1
    data = root / "site" / "data"
    assert read(data, "status.json")["ok"] is True
    # The page reads the date from here, since it cannot read config/app.json.
    assert read(data, "latest.json")["stop_fetching_after"] == STOP


@pytest.mark.parametrize("now", [NEXT_DAY, datetime(2030, 1, 1, tzinfo=timezone.utc)])
def test_after_the_stop_date_nothing_is_fetched_or_written(tmp_path, monkeypatch, caplog, now):
    root = make_root(tmp_path, REAL_URL, stop_fetching_after=STOP)
    calls = fake_scout(monkeypatch)
    assert main([], root=root, now=BEFORE) == 0  # an ordinary run first, so there is data to protect
    before = data_snapshot(root)
    assert len(calls) == 1

    gh_output, summary = tmp_path / "gh_output.txt", tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_OUTPUT", str(gh_output))
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    with caplog.at_level("INFO"):
        assert main([], root=root, now=now) == 0  # exits 0, so the workflow does not go red

    assert len(calls) == 1  # no second request
    assert data_snapshot(root) == before  # not one byte changed, and no new file
    assert gh_output.read_text() == "ok=true\nskipped=true\n"  # ok=true: the workflow only fails on ok=false
    assert STOP in summary.read_text()
    assert "skipped" in caplog.text


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_after_the_stop_date_git_has_nothing_to_commit(tmp_path, monkeypatch):
    # The workflow's "Commit changed data" step commits only when `git status --porcelain site/data` is non-empty.
    root = make_root(tmp_path, REAL_URL, stop_fetching_after=STOP)
    fake_scout(monkeypatch)
    main([], root=root, now=BEFORE)

    def git(*args):
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True).stdout

    git("init", "-q")
    git("add", "-A")
    git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "data")
    assert git("status", "--porcelain", "site/data") == ""

    main([], root=root, now=NEXT_DAY)
    assert git("status", "--porcelain", "site/data") == ""  # archived: nothing to commit

    main([], root=root, now=LAST_DAY)
    assert git("status", "--porcelain", "site/data") != ""  # a run before the end does change files, so the check means something


def test_an_archived_run_needs_no_user_agent_and_touches_nothing(tmp_path, monkeypatch):
    root = make_root(tmp_path, "<REPO_URL>", stop_fetching_after=STOP)
    calls = fake_scout(monkeypatch)
    assert main([], root=root, now=NEXT_DAY) == 0
    assert calls == [] and not (root / "site").exists()


def test_fixture_mode_ignores_the_stop_date(tmp_path, monkeypatch):
    root = make_root(tmp_path, "<REPO_URL>", stop_fetching_after=STOP)
    calls = fake_scout(monkeypatch)
    assert main(["--fixture", str(FIXTURES / "scout_sample.json")], root=root, now=NEXT_DAY) == 0
    assert calls == []
    assert read(root / "site" / "data", "latest.json")["source"] == "fixture"


@pytest.mark.parametrize("extra", [{}, {"stop_fetching_after": None}])
def test_without_an_end_date_it_keeps_fetching(tmp_path, monkeypatch, extra):
    root = make_root(tmp_path, REAL_URL, **extra)
    calls = fake_scout(monkeypatch)
    assert main([], root=root, now=datetime(2040, 1, 1, tzinfo=timezone.utc)) == 0
    assert len(calls) == 1
    assert read(root / "site" / "data", "latest.json")["stop_fetching_after"] is None


@pytest.mark.parametrize("bad", ["2027-02-30", "28/02/2027", "20270228", "2027-2-28", "", " 2027-02-28", 20270228, True, ["2027-02-28"]])
def test_a_bad_stop_date_is_a_config_error_not_a_silent_no_end_date(tmp_path, monkeypatch, capsys, bad):
    root = make_root(tmp_path, REAL_URL, stop_fetching_after=bad)
    calls = fake_scout(monkeypatch)
    assert main([], root=root, now=BEFORE) == 2
    assert "stop_fetching_after" in capsys.readouterr().err
    assert calls == [] and not (root / "site").exists()


def test_parse_stop_date():
    assert parse_stop_date({}) is None
    assert parse_stop_date({"stop_fetching_after": None}) is None
    assert parse_stop_date({"stop_fetching_after": STOP}) == date(2027, 2, 28)
    with pytest.raises(ConfigError, match="stop_fetching_after"):
        parse_stop_date({"stop_fetching_after": "2027-02-30"})


def test_is_archived_uses_the_utc_date_and_treats_the_stop_date_as_a_fetching_day():
    stop = date(2027, 2, 28)
    assert not is_archived(stop, LAST_DAY)
    assert is_archived(stop, NEXT_DAY)
    assert not is_archived(None, NEXT_DAY)
    # 20:00 on the 28th in UTC-8 is already 04:00 UTC on 1 March, so it counts as past the date.
    assert is_archived(stop, datetime(2027, 2, 28, 20, 0, tzinfo=timezone(timedelta(hours=-8))))


def test_github_output_and_step_summary_for_a_skipped_run(tmp_path, monkeypatch):
    target, summary = tmp_path / "out.txt", tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_OUTPUT", str(target))
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    write_github_output(True, skipped=True)
    write_step_summary("hello")
    assert target.read_text() == "ok=true\nskipped=true\n"
    assert summary.read_text() == "hello\n"


def test_the_workflow_only_goes_red_on_an_explicit_failure_and_only_commits_changed_data():
    # A skipped run reports ok=true and changes no file; these two lines in the workflow are what turn that into
    # "green, no commit". If someone edits them, this test says why it matters.
    text = (ROOT / ".github" / "workflows" / "update-and-deploy.yml").read_text()
    assert "if: needs.update.outputs.ok == 'false'" in text
    assert "git status --porcelain site/data" in text
