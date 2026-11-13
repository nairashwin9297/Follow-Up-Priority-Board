"""Tests for pipeline.history, using parsed rows from the real Scout fixture."""
import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pipeline.history import RETENTION_DAYS, empty_history, update_history
from pipeline.parse import parse_payload, to_iso

FIXTURE = Path(__file__).parent / "fixtures" / "scout_sample.json"
OBJECTS = parse_payload(json.loads(FIXTURE.read_text()))["objects"]
A, B = OBJECTS[0], OBJECTS[1]
T0 = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)


def test_empty_history_shape():
    assert empty_history() == {"schema_version": 1, "objects": {}}


def test_first_run_records_every_object_once():
    history = update_history(empty_history(), OBJECTS, T0)
    assert set(history["objects"]) == {o["objectName"] for o in OBJECTS}
    entry = history["objects"][A["objectName"]]
    assert entry["first_seen"] == entry["last_seen"] == to_iso(T0)
    assert entry["snapshots"] == [{
        "t": A["lastRun"], "nObs": A["nObs"], "arc": A["arc"],
        "unc": A["unc"], "uncP1": A["uncP1"], "neoScore": A["neoScore"],
    }]


def test_same_lastRun_does_not_add_a_snapshot_but_updates_last_seen():
    first = update_history(empty_history(), [A], T0)
    later = T0 + timedelta(hours=6)
    second = update_history(first, [A], later)
    entry = second["objects"][A["objectName"]]
    assert len(entry["snapshots"]) == 1
    assert entry["last_seen"] == to_iso(later)
    assert entry["first_seen"] == to_iso(T0)


def test_new_lastRun_appends_and_first_seen_stays_put():
    first = update_history(empty_history(), [A], T0)
    rerun = {**A, "lastRun": "2026-11-13T03:00:00Z", "nObs": A["nObs"] + 4}
    second = update_history(first, [rerun], T0 + timedelta(hours=6))
    entry = second["objects"][A["objectName"]]
    assert [s["t"] for s in entry["snapshots"]] == [A["lastRun"], "2026-11-13T03:00:00Z"]
    assert entry["snapshots"][1]["nObs"] == A["nObs"] + 4
    assert entry["first_seen"] == to_iso(T0)


def test_missing_lastRun_records_presence_without_a_snapshot():
    history = update_history(empty_history(), [{**A, "lastRun": None}], T0)
    entry = history["objects"][A["objectName"]]
    assert entry["snapshots"] == []
    assert entry["first_seen"] == to_iso(T0)


def test_unlisted_object_keeps_its_old_last_seen():
    first = update_history(empty_history(), [A, B], T0)
    second = update_history(first, [B], T0 + timedelta(days=1))
    assert second["objects"][A["objectName"]]["last_seen"] == to_iso(T0)
    assert second["objects"][B["objectName"]]["last_seen"] == to_iso(T0 + timedelta(days=1))


def test_pruning_drops_objects_last_seen_over_30_days_ago():
    first = update_history(empty_history(), [A, B], T0)
    just_over = T0 + timedelta(days=RETENTION_DAYS, seconds=1)
    pruned = update_history(first, [B], just_over)
    assert A["objectName"] not in pruned["objects"]
    assert B["objectName"] in pruned["objects"]


def test_pruning_keeps_objects_at_exactly_30_days():
    first = update_history(empty_history(), [A, B], T0)
    kept = update_history(first, [B], T0 + timedelta(days=RETENTION_DAYS))
    assert A["objectName"] in kept["objects"]


def test_currently_listed_object_is_never_pruned():
    first = update_history(empty_history(), [A], T0)
    later = update_history(first, [A], T0 + timedelta(days=90))
    assert A["objectName"] in later["objects"]


def test_object_that_returns_within_30_days_keeps_first_seen():
    first = update_history(empty_history(), [A], T0)
    gone = update_history(first, [B], T0 + timedelta(days=10))
    back = update_history(gone, [A], T0 + timedelta(days=20))
    entry = back["objects"][A["objectName"]]
    assert entry["first_seen"] == to_iso(T0)
    assert entry["last_seen"] == to_iso(T0 + timedelta(days=20))


def test_input_history_is_not_mutated():
    first = update_history(empty_history(), [A], T0)
    snapshot = copy.deepcopy(first)
    update_history(first, [A, B], T0 + timedelta(days=40))
    assert first == snapshot
