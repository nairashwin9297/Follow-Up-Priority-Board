"""Tests for pipeline.factors.

Expected values are worked out by hand from the formulas in SPEC.md section 5,
choosing inputs where the log math comes out exact (e.g. 6 h is the geometric
middle of 0.5 h and 72 h, so it normalizes to exactly 0.5).
"""
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from pipeline.factors import (
    FACTOR_NAMES, badges, closeness, clamp01, compute_factors, compute_object,
    lognorm, observability, pha, sparse, urgency,
)
from pipeline.parse import parse_payload, to_iso

ROOT = Path(__file__).parent.parent
SCORING = json.loads((ROOT / "config" / "scoring.json").read_text())
P = SCORING["factors"]
B = SCORING["badges"]
NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
FIELDS = ("nObs", "arc", "unc", "uncP1", "neoScore", "phaScore", "caDist", "moid",
          "Vmag", "elong", "lastRun")


def raw(**values):
    """A parsed object where every input is missing unless given."""
    row = {f: None for f in FIELDS}
    row.update(objectName="TEST", **values)
    return row


# --- helpers ------------------------------------------------------------------

def test_clamp01():
    assert (clamp01(-1), clamp01(0.4), clamp01(7)) == (0.0, 0.4, 1.0)


@pytest.mark.parametrize("x, expected", [(1, 0), (600, 1), (0.1, 0), (6000, 1)])
def test_lognorm_ends_and_clamping(x, expected):
    assert lognorm(x, 1, 600) == expected


def test_lognorm_midpoint():
    assert lognorm(100 ** 0.5, 1, 100) == pytest.approx(0.5)


@pytest.mark.parametrize("x", [0, -3])
def test_lognorm_non_positive_clamps_and_warns(x, caplog):
    with caplog.at_level(logging.WARNING):
        assert lognorm(x, 1, 600) == 0.0
    assert "<= 0" in caplog.text


# --- urgency ------------------------------------------------------------------

@pytest.mark.parametrize("uncP1, unc, expected", [
    (1, 1, 0.0),            # smallest uncertainty, no growth
    (600, 60, 1.0),         # largest uncertainty, 10x growth in a day
    (600, 600, 0.7),        # large but not growing: level term only
    (1, 0.1, 0.3),          # tiny but 10x growth: growth term only
    (4800, 4800, 0.7),      # beyond the range is clamped, not extrapolated
    (600 ** 0.5, 600 ** 0.5, 0.35),  # mid-range level, no growth
    (1, 10, 0.0),           # uncertainty shrinks (seen in real data): growth clamps to 0
])
def test_urgency_values(uncP1, unc, expected):
    value, missing = urgency(raw(uncP1=uncP1, unc=unc), P["urgency"])
    assert value == pytest.approx(expected)
    assert missing == []


@pytest.mark.parametrize("unc", [None, 0])
def test_urgency_without_usable_unc_uses_level_only(unc):
    value, missing = urgency(raw(uncP1=600, unc=unc), P["urgency"])
    assert value == pytest.approx(1.0)  # 0.7 * 1 renormalized by 0.7
    assert missing == ["urgency.unc"]


def test_urgency_null_without_uncP1():
    assert urgency(raw(unc=5), P["urgency"]) == (None, ["urgency"])


# --- sparse -------------------------------------------------------------------

@pytest.mark.parametrize("nObs, arc, expected", [
    (3, 0.5, 1.0),        # fewest observations, shortest arc
    (20, 72, 0.0),        # plenty of both
    (20, 0.5, 0.5),       # only the arc is short
    (11.5, 6, 0.5),       # middle of both scales
    (2, 0.5, 1.0),        # below the range clamps
    (500, 5000, 0.0),     # above the range clamps
])
def test_sparse_values(nObs, arc, expected):
    value, missing = sparse(raw(nObs=nObs, arc=arc), P["sparse"])
    assert value == pytest.approx(expected)
    assert missing == []


def test_sparse_renormalizes_over_present_input():
    assert sparse(raw(nObs=3), P["sparse"]) == (pytest.approx(1.0), ["sparse.arc"])
    assert sparse(raw(arc=72), P["sparse"]) == (pytest.approx(0.0), ["sparse.nObs"])


def test_sparse_null_when_both_missing():
    assert sparse(raw(), P["sparse"]) == (None, ["sparse"])


def test_sparse_zero_arc_counts_as_shortest(caplog):
    with caplog.at_level(logging.WARNING):
        value, _ = sparse(raw(nObs=3, arc=0), P["sparse"])
    assert value == pytest.approx(1.0)
    assert "<= 0" in caplog.text


# --- pha ----------------------------------------------------------------------

@pytest.mark.parametrize("score, expected", [(0, 0.0), (50, 0.5), (68, 0.68), (100, 1.0)])
def test_pha_values(score, expected):
    assert pha(raw(phaScore=score), P["pha"]) == (pytest.approx(expected), [])


def test_pha_missing():
    assert pha(raw(), P["pha"]) == (None, ["pha"])


# --- observability ------------------------------------------------------------

@pytest.mark.parametrize("vmag, elong, expected", [
    (18, 135, 1.0),
    (24, 45, 0.0),
    (21, 90, 0.5),
    (15, 170, 1.0),       # brighter / farther than the range clamps
    (28, 20, 0.0),
])
def test_observability_values(vmag, elong, expected):
    value, missing = observability(raw(Vmag=vmag, elong=elong), P["observability"])
    assert value == pytest.approx(expected)
    assert missing == []


def test_observability_renormalizes_over_present_input():
    assert observability(raw(Vmag=18), P["observability"]) == (pytest.approx(1.0), ["observability.elong"])
    assert observability(raw(elong=45), P["observability"]) == (pytest.approx(0.0), ["observability.Vmag"])


def test_observability_null_when_both_missing():
    assert observability(raw(), P["observability"]) == (None, ["observability"])


# --- closeness ----------------------------------------------------------------

@pytest.mark.parametrize("ca, expected", [(0.1, 1.0), (100, 0.0), (10 ** 0.5, 0.5), (0.01, 1.0), (500, 0.0)])
def test_closeness_from_caDist(ca, expected):
    value, source = closeness(raw(caDist=ca), P["closeness"])
    assert value == pytest.approx(expected)
    assert source == "caDist"


def test_closeness_falls_back_to_moid_in_lunar_distances():
    au_to_ld = 389.17
    value, source = closeness(raw(moid=100 / au_to_ld), P["closeness"])  # exactly 100 LD
    assert (value, source) == (pytest.approx(0.0), "moid")
    value, source = closeness(raw(moid=0.1 / au_to_ld), P["closeness"])  # exactly 0.1 LD
    assert (value, source) == (pytest.approx(1.0), "moid")
    value, _ = closeness(raw(moid=1), P["closeness"])  # 1 au = 389.17 LD, beyond the range
    assert value == 0.0


def test_closeness_prefers_caDist_over_moid():
    value, source = closeness(raw(caDist=100, moid=0.0001), P["closeness"])
    assert (value, source) == (pytest.approx(0.0), "caDist")


def test_closeness_zero_caDist_is_present_not_missing(caplog):
    with caplog.at_level(logging.WARNING):
        value, source = closeness(raw(caDist=0, moid=1), P["closeness"])
    assert (value, source) == (pytest.approx(1.0), "caDist")


def test_closeness_null_when_both_missing():
    assert closeness(raw(), P["closeness"]) == (None, None)


# --- compute_factors / compute_object ----------------------------------------

def test_everything_missing_gives_null_factors_and_lists_them():
    factors, source, missing = compute_factors(raw(), P)
    assert all(factors[name] is None for name in FACTOR_NAMES)
    assert source is None
    assert sorted(missing) == sorted(FACTOR_NAMES)


def test_missing_neoScore_gives_null_gate_and_is_flagged():
    obj = compute_object(raw(phaScore=10), SCORING, NOW)
    assert obj["gate"] is None
    assert "gate" in obj["missing"]
    assert obj["factors"]["pha"] == 0.1


def test_gate_is_neoScore_over_100():
    assert compute_object(raw(neoScore=37), SCORING, NOW)["gate"] == 0.37


def test_factor_output_is_rounded_to_four_decimals():
    obj = compute_object(raw(phaScore=1 / 3 * 100), SCORING, NOW)
    assert obj["factors"]["pha"] == 0.3333


def test_real_fixture_objects_score_cleanly():
    rows = parse_payload(json.loads((ROOT / "tests/fixtures/scout_sample.json").read_text()))["objects"]
    for row in rows:
        obj = compute_object(row, SCORING, NOW)
        assert set(obj["factors"]) == set(FACTOR_NAMES)
        for name, value in obj["factors"].items():
            assert value is not None and 0.0 <= value <= 1.0, (row["objectName"], name)
        assert 0.0 <= obj["gate"] <= 1.0
        # The source must match what the real row actually had.
        assert obj["closeness_source"] == ("caDist" if row["caDist"] is not None else "moid")
        assert set(obj["badges"]) <= set(B)
        assert obj["missing"] == [] or all(m.count(".") == 1 for m in obj["missing"])


# --- badges -------------------------------------------------------------------

def test_orbit_uncertain_boundary():
    assert "orbit_uncertain" not in badges(raw(uncP1=60), B, NOW)
    assert "orbit_uncertain" in badges(raw(uncP1=60.01), B, NOW)
    assert "orbit_uncertain" not in badges(raw(), B, NOW)


@pytest.mark.parametrize("nObs, arc, expected", [
    (5, 10, True),       # few observations alone
    (6, 10, False),
    (10, 1.99, True),    # short arc alone
    (10, 2, False),
    (None, 10, False),
    (None, None, False),
    (None, 1, True),     # one input missing, the other still triggers it
])
def test_few_observations(nObs, arc, expected):
    assert ("few_observations" in badges(raw(nObs=nObs, arc=arc), B, NOW)) is expected


@pytest.mark.parametrize("ca, expected", [(4.99, True), (5, False), (None, False), (0, True)])
def test_close_approach(ca, expected):
    assert ("close_approach" in badges(raw(caDist=ca), B, NOW)) is expected


def test_close_approach_ignores_moid():
    assert "close_approach" not in badges(raw(moid=0.0001), B, NOW)


@pytest.mark.parametrize("age, expected", [
    (timedelta(hours=24), False),                  # exactly 24 h is not older than 24 h
    (timedelta(hours=24, minutes=1), True),
    (timedelta(hours=1), False),
])
def test_stale_scout_run(age, expected):
    assert ("stale_scout_run" in badges(raw(lastRun=to_iso(NOW - age)), B, NOW)) is expected


def test_no_lastRun_is_not_flagged_stale():
    assert "stale_scout_run" not in badges(raw(), B, NOW)


def test_badges_come_in_config_order():
    row = raw(uncP1=100, nObs=3, caDist=1, lastRun=to_iso(NOW - timedelta(days=2)))
    assert badges(row, B, NOW) == ["orbit_uncertain", "few_observations", "close_approach", "stale_scout_run"]
