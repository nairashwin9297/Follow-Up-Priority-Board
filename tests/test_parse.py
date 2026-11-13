"""Tests for pipeline.parse.

Every row used here comes from tests/fixtures/scout_sample.json (a real Scout
response). Malformed inputs are made by corrupting copies of those real rows,
never by inventing objects. scout_malformed.json is built the same way; its
"_note" key says exactly which values were corrupted.
"""
import copy
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import pytest

from pipeline.parse import (
    NUMERIC_FIELDS,
    ValidationError,
    parse_payload,
    parse_utc,
    to_number,
)

FIXTURES = Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIXTURES / name).read_text())


SAMPLE = load("scout_sample.json")


def payload_with(rows):
    """A payload shaped like the real one, holding the given rows."""
    return {"signature": dict(SAMPLE["signature"]), "count": str(len(rows)), "data": rows}


def real_rows(n):
    return copy.deepcopy(SAMPLE["data"][:n])


# --- The real fixture ---------------------------------------------------------

def test_real_fixture_parses_without_failures():
    result = parse_payload(SAMPLE, expected_version="1.3")
    assert result["scout_version"] == "1.3"
    assert result["scout_count"] == int(SAMPLE["count"]) == len(SAMPLE["data"])
    assert len(result["objects"]) == len(SAMPLE["data"])
    assert result["stats"]["unparseable_rows"] == 0
    assert result["stats"]["failed_values"] == 0


def test_real_fixture_numbers_converted_and_nulls_kept():
    objects = {o["objectName"]: o for o in parse_payload(SAMPLE)["objects"]}
    for row in SAMPLE["data"]:
        parsed = objects[row["objectName"]]
        for field in NUMERIC_FIELDS:
            if row[field] is None:
                assert parsed[field] is None, field
            else:
                assert isinstance(parsed[field], (int, float)), field
                assert parsed[field] == float(row[field]), field


def test_real_fixture_really_contains_nulls_and_strings():
    # Guards the test above: it only means something if the fixture has both.
    rows = SAMPLE["data"]
    assert any(r["caDist"] is None for r in rows)
    assert any(r["rating"] is None for r in rows)
    assert all(isinstance(r["uncP1"], str) for r in rows)


def test_real_fixture_timestamps_become_iso_utc():
    first_raw = SAMPLE["data"][0]
    first = parse_payload(SAMPLE)["objects"][0]
    expected = parse_utc(first_raw["lastRun"]).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert first["lastRun"] == expected
    assert first["lastRun"].replace("T", " ")[:16] == first_raw["lastRun"]


# --- to_number ----------------------------------------------------------------

@pytest.mark.parametrize("value, expected", [
    ("1.5", (1.5, True)),
    ("0.0002", (0.0002, True)),
    ("-34", (-34.0, True)),
    (17, (17, True)),
    (None, (None, True)),       # null is allowed, not a failure
    ("abc", (None, False)),
    ("", (None, False)),
    ("nan", (None, False)),
    ("inf", (None, False)),
    (True, (None, False)),
    ([1], (None, False)),
])
def test_to_number(value, expected):
    assert to_number(value) == expected


# --- parse_utc ----------------------------------------------------------------

def test_parse_utc_minutes():
    assert parse_utc("2026-11-12 10:48") == datetime(2026, 11, 12, 10, 48, tzinfo=timezone.utc)


def test_parse_utc_seconds():
    assert parse_utc("2026-11-12 10:48:07") == datetime(2026, 11, 12, 10, 48, 7, tzinfo=timezone.utc)


def test_parse_utc_is_aware_utc():
    assert parse_utc("2026-11-12 10:48").utcoffset().total_seconds() == 0


@pytest.mark.parametrize("text", [
    "2026-11-12T10:48:00Z",  # not Scout's format; refuse rather than guess
    "12/11/2026 10:48",
    "2026-13-01 00:00",
    "",
    None,
    1731408480,
])
def test_parse_utc_rejects_other_formats(text):
    assert parse_utc(text) is None


# --- Whole-payload validation -------------------------------------------------

@pytest.mark.parametrize("payload, message", [
    ([], "not a JSON object"),
    ("oops", "not a JSON object"),
    ({"signature": {"version": "1.3"}, "error": "database unavailable"}, "error"),
    ({"count": "0"}, "no signature"),
    ({"signature": {"version": "1.3"}, "count": "abc", "data": []}, "count"),
    ({"signature": {"version": "1.3"}, "data": []}, "count"),
    ({"signature": {"version": "1.3"}, "count": "-1", "data": []}, "count"),
    ({"signature": {"version": "1.3"}, "count": "1.5", "data": []}, "count"),
    ({"signature": {"version": "1.3"}, "count": "2"}, "not a list"),
    ({"signature": {"version": "1.3"}, "count": "2", "data": "rows"}, "not a list"),
    ({"signature": {"version": "1.3"}, "count": "2", "data": []}, "empty"),
])
def test_malformed_payloads_rejected(payload, message):
    with pytest.raises(ValidationError, match=message):
        parse_payload(payload)


def test_malformed_fixture_rejected():
    with pytest.raises(ValidationError, match="3 of 4 rows are unparseable"):
        parse_payload(load("scout_malformed.json"))


def test_count_zero_without_data_is_empty_not_error():
    result = parse_payload({"signature": dict(SAMPLE["signature"]), "count": "0"})
    assert result["objects"] == []
    assert result["scout_count"] == 0


def test_bad_number_becomes_null_and_row_is_kept():
    rows = real_rows(4)
    rows[0]["Vmag"] = "abc"
    result = parse_payload(payload_with(rows))
    assert len(result["objects"]) == 4
    assert result["objects"][0]["Vmag"] is None
    assert result["stats"] == {"rows": 4, "unparseable_rows": 1, "failed_values": 1, "unknown_fields": []}


def test_exactly_half_unparseable_is_accepted():
    rows = real_rows(4)
    rows[0]["uncP1"] = "n/a"
    rows[1]["nObs"] = "many"
    assert parse_payload(payload_with(rows))["stats"]["unparseable_rows"] == 2


def test_bad_non_scoring_field_does_not_make_row_unparseable():
    rows = real_rows(2)
    rows[0]["rmsN"] = "x"
    stats = parse_payload(payload_with(rows))["stats"]
    assert stats["unparseable_rows"] == 0
    assert stats["failed_values"] == 1


def test_bad_timestamp_counts_as_unparseable():
    rows = real_rows(2)
    rows[0]["lastRun"] = "yesterday"
    result = parse_payload(payload_with(rows))
    assert result["objects"][0]["lastRun"] is None
    assert result["stats"]["unparseable_rows"] == 1


def test_row_without_object_name_is_dropped():
    rows = real_rows(3)
    del rows[0]["objectName"]
    result = parse_payload(payload_with(rows))
    assert [o["objectName"] for o in result["objects"]] == [r["objectName"] for r in rows[1:]]


def test_duplicate_object_name_keeps_first(caplog):
    rows = real_rows(2)
    rows.append(copy.deepcopy(rows[0]))
    rows[2]["nObs"] = 999
    result = parse_payload(payload_with(rows))
    assert len(result["objects"]) == 2
    assert result["objects"][0]["nObs"] == SAMPLE["data"][0]["nObs"]
    assert "duplicate" in caplog.text


def test_unknown_fields_are_dropped():
    rows = real_rows(1)
    rows[0]["somethingNew"] = "1"
    assert "somethingNew" not in parse_payload(payload_with(rows))["objects"][0]


def unknown_field_warnings(caplog):
    return [r for r in caplog.records if "doesn't know" in r.getMessage()]


def test_unknown_field_warns_once_per_run_and_names_every_new_field(caplog):
    rows = real_rows(4)
    for row in rows:                       # the same new field on every row ...
        row["somethingNew"] = "1"
    rows[2]["alsoNew"] = "x"               # ... and a second one on a single row
    with caplog.at_level(logging.WARNING):
        result = parse_payload(payload_with(rows))
    warnings = unknown_field_warnings(caplog)
    assert len(warnings) == 1              # one line per run, not one per row
    assert "alsoNew, somethingNew" in warnings[0].getMessage()
    assert result["stats"]["unknown_fields"] == ["alsoNew", "somethingNew"]
    assert len(result["objects"]) == 4     # still parsed; the warning is only a heads-up


def test_unknown_field_on_a_dropped_row_is_still_reported(caplog):
    rows = real_rows(3)
    del rows[0]["objectName"]
    rows[0]["somethingNew"] = "1"
    with caplog.at_level(logging.WARNING):
        parse_payload(payload_with(rows))
    assert len(unknown_field_warnings(caplog)) == 1


def test_real_fixture_has_no_unknown_fields(caplog):
    with caplog.at_level(logging.WARNING):
        result = parse_payload(SAMPLE)
    assert unknown_field_warnings(caplog) == []
    assert result["stats"]["unknown_fields"] == []


def test_version_mismatch_warns_but_parses(caplog):
    payload = copy.deepcopy(SAMPLE)
    payload["signature"]["version"] = "2.0"
    with caplog.at_level(logging.WARNING):
        result = parse_payload(payload, expected_version="1.3")
    assert len(result["objects"]) == len(SAMPLE["data"])
    assert "expected '1.3'" in caplog.text


def test_count_mismatch_warns(caplog):
    payload = payload_with(real_rows(2))
    payload["count"] = "3"
    with caplog.at_level(logging.WARNING):
        parse_payload(payload)
    assert "count is 3 but data has 2 rows" in caplog.text


# --- ISO round trip -----------------------------------------------------------

def test_iso_round_trip():
    from pipeline.parse import from_iso, to_iso
    dt = datetime(2026, 11, 12, 10, 48, 7, tzinfo=timezone.utc)
    assert to_iso(dt) == "2026-11-12T10:48:07Z"
    assert from_iso(to_iso(dt)) == dt
