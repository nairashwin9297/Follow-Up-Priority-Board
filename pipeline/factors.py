"""Normalized 0..1 factors, the gate, and badges for one parsed Scout object.

All thresholds and weights come from config/scoring.json. This module is the
only place factor math lives; the browser just takes a weighted sum of the
numbers written here.

Missing data is never imputed. A factor built from several inputs averages
whichever inputs exist (weights renormalized) and is None only when none exist.
"""
import logging
import math
from datetime import timedelta

from .parse import from_iso

log = logging.getLogger(__name__)

FACTOR_NAMES = ("urgency", "sparse", "pha", "observability", "closeness")


def clamp01(x):
    return max(0.0, min(1.0, x))


def lognorm(x, lo, hi):
    """Place x on a log scale where lo -> 0 and hi -> 1, clamped to [0, 1]."""
    if x <= 0:
        # log10 is undefined here. Treat as "at or below lo" instead of crashing.
        log.warning("lognorm: value %s is <= 0; treating it as at or below %s", x, lo)
        return 0.0
    return clamp01((math.log10(x) - math.log10(lo)) / (math.log10(hi) - math.log10(lo)))


def _blend(parts):
    """Weighted mean of (weight, value) pairs, skipping None values."""
    present = [(w, v) for w, v in parts if v is not None]
    if not present:
        return None
    return sum(w * v for w, v in present) / sum(w for w, _ in present)


def _missing(name, value, inputs):
    """Names to list in an object's "missing" field.

    "urgency" means the whole factor is null; "urgency.unc" means the factor
    was computed but one of its inputs was absent.
    """
    if value is None:
        return [name]
    return [f"{name}.{key}" for key, v in inputs.items() if v is None]


def urgency(raw, p):
    """How fast the position uncertainty is growing, and how big it will be."""
    uncP1, unc = raw["uncP1"], raw["unc"]
    if unc is not None and unc <= 0:
        unc = None  # a zero uncertainty can't give a growth ratio
    level = None if uncP1 is None else lognorm(uncP1, p["uncP1_lo_arcmin"], p["uncP1_hi_arcmin"])
    growth = None
    if uncP1 is not None and uncP1 > 0 and unc is not None:
        # clamp01 also covers the rare rows where the uncertainty shrinks.
        growth = clamp01(math.log10(uncP1 / unc) / p["growth_full_decades"])
    value = _blend([(p["level_weight"], level), (p["growth_weight"], growth)])
    # growth needs uncP1 too, so it can't be computed when uncP1 is the missing one.
    return value, _missing("urgency", value, {"unc": unc} if uncP1 is not None else {})


def sparse(raw, p):
    """High when there are few observations and the arc is short."""
    nObs, arc = raw["nObs"], raw["arc"]
    n_term = None
    if nObs is not None:
        n_term = 1 - clamp01((nObs - p["nObs_min"]) / (p["nObs_max"] - p["nObs_min"]))
    arc_term = None if arc is None else 1 - lognorm(arc, p["arc_lo_h"], p["arc_hi_h"])
    value = _blend([(p["nObs_weight"], n_term), (p["arc_weight"], arc_term)])
    return value, _missing("sparse", value, {"nObs": nObs, "arc": arc})


def pha(raw, p):
    """Scout's PHA likelihood score, rescaled from 0-100 to 0-1."""
    score = raw["phaScore"]
    value = None if score is None else clamp01(score / 100)
    return value, _missing("pha", value, {})


def observability(raw, p):
    """Coarse: bright and far from the Sun is easier to follow up. Not site-specific."""
    vmag, elong = raw["Vmag"], raw["elong"]
    v_term = None
    if vmag is not None:
        v_term = clamp01((p["vmag_faint"] - vmag) / (p["vmag_faint"] - p["vmag_bright"]))
    e_term = None
    if elong is not None:
        e_term = clamp01((elong - p["elong_min_deg"]) / (p["elong_max_deg"] - p["elong_min_deg"]))
    value = _blend([(p["vmag_weight"], v_term), (p["elong_weight"], e_term)])
    return value, _missing("observability", value, {"Vmag": vmag, "elong": elong})


def closeness(raw, p):
    """Returns (value, source). Uses caDist when present, otherwise MOID in lunar distances."""
    if raw["caDist"] is not None:
        distance_ld, source = raw["caDist"], "caDist"
    elif raw["moid"] is not None:
        distance_ld, source = raw["moid"] * p["au_to_ld"], "moid"
    else:
        return None, None
    return 1 - lognorm(distance_ld, p["ld_lo"], p["ld_hi"]), source


def compute_factors(raw, factor_cfg):
    """Returns (factors, closeness_source, missing)."""
    factors, missing = {}, []
    for name, fn in (("urgency", urgency), ("sparse", sparse), ("pha", pha),
                     ("observability", observability)):
        factors[name], names = fn(raw, factor_cfg[name])
        missing += names
    factors["closeness"], source = closeness(raw, factor_cfg["closeness"])
    if factors["closeness"] is None:
        missing.append("closeness")  # caDist and moid are alternatives, so only flag when both are gone
    return factors, source, missing


def badges(raw, badge_cfg, now):
    """Badge ids in config order. "new" is added later by main.py, which knows the history."""
    found = []
    c = badge_cfg["orbit_uncertain"]
    if raw["uncP1"] is not None and raw["uncP1"] > c["uncP1_gt_arcmin"]:
        found.append("orbit_uncertain")
    c = badge_cfg["few_observations"]
    if (raw["nObs"] is not None and raw["nObs"] < c["nObs_lt"]) or \
       (raw["arc"] is not None and raw["arc"] < c["arc_lt_h"]):
        found.append("few_observations")
    c = badge_cfg["close_approach"]
    if raw["caDist"] is not None and raw["caDist"] < c["caDist_lt_ld"]:
        found.append("close_approach")
    c = badge_cfg["stale_scout_run"]
    if raw["lastRun"] is not None:
        age = now - from_iso(raw["lastRun"])
        if age > timedelta(hours=c["lastRun_older_than_h"]):
            found.append("stale_scout_run")
    return found


def compute_object(raw, scoring, now):
    """Everything the browser needs for one object, except first_seen and the "new" badge."""
    factors, source, missing = compute_factors(raw, scoring["factors"])
    gate = None if raw["neoScore"] is None else clamp01(raw["neoScore"] / 100)
    if gate is None:
        missing.append("gate")
    return {
        "objectName": raw["objectName"],
        "raw": raw,
        # 4 decimals is far finer than the UI shows and keeps git diffs short.
        "factors": {k: None if v is None else round(v, 4) for k, v in factors.items()},
        "closeness_source": source,
        "gate": gate,
        "badges": badges(raw, scoring["badges"], now),
        "missing": sorted(missing),
    }
