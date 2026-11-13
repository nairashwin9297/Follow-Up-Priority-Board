"""Validate a Scout summary payload and convert its fields to Python types.

Scout sends most numbers as strings and some as null. Parsing is defensive:
a bad value becomes None (and is counted and logged) instead of crashing.
Only a payload that is broken as a whole raises ValidationError.
"""
import logging
import math
from datetime import datetime, timezone

log = logging.getLogger(__name__)

NUMERIC_FIELDS = (
    "nObs", "arc", "unc", "uncP1", "neoScore", "phaScore", "caDist", "moid",
    "Vmag", "H", "elong", "rate", "rating",
    # Not used for scoring; kept so the detail view can show every raw value.
    "ieoScore", "neo1kmScore", "geocentricScore", "tisserandScore", "vInf", "rmsN",
)
TEXT_FIELDS = ("ra", "dec")
TIME_FIELDS = ("lastRun", "tEphem")

# A bad value in one of these makes the row "unparseable" for the 50% rule,
# because it would change a factor, the gate, a badge, or the history key.
SCORING_FIELDS = (
    "nObs", "arc", "unc", "uncP1", "neoScore", "phaScore",
    "caDist", "moid", "Vmag", "elong", "lastRun",
)

MAX_UNPARSEABLE_FRACTION = 0.5
TIME_FORMATS = ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S")
ISO_FORMAT = "%Y-%m-%dT%H:%M:%SZ"  # what we write to JSON; always UTC


class ValidationError(Exception):
    """The payload can't be trusted as a whole; the caller keeps the old data."""


def to_number(value):
    """Return (number or None, ok). Null is fine; anything unparseable is not ok."""
    if value is None:
        return None, True
    if isinstance(value, bool):  # bool is a subclass of int, but True isn't a count
        return None, False
    if isinstance(value, int):
        return value, True
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None, False
    if not math.isfinite(number):  # float() happily accepts "nan" and "inf"
        return None, False
    return number, True


def parse_utc(text):
    """Parse Scout's "YYYY-MM-DD HH:MM[:SS]" as UTC, or return None."""
    if not isinstance(text, str):
        return None
    for fmt in TIME_FORMATS:
        try:
            # strptime returns a naive datetime. Scout times are UTC, so attach
            # UTC here rather than risk it being read as local time later.
            return datetime.strptime(text.strip(), fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def to_iso(dt):
    """Format an aware UTC datetime as ISO-8601 with a Z suffix."""
    return dt.strftime(ISO_FORMAT)


def from_iso(text):
    """Inverse of to_iso. Reads only our own output, so a bad string is a bug: let it raise."""
    return datetime.strptime(text, ISO_FORMAT).replace(tzinfo=timezone.utc)


def parse_row(row):
    """Return (parsed_row, bad_fields). Fields we don't know about are dropped."""
    parsed = {"objectName": row["objectName"]}
    bad = []
    for field in NUMERIC_FIELDS:
        parsed[field], ok = to_number(row.get(field))
        if not ok:
            bad.append(field)
    for field in TIME_FIELDS:
        value = row.get(field)
        dt = parse_utc(value)
        parsed[field] = to_iso(dt) if dt else None
        if value is not None and dt is None:
            bad.append(field)
    for field in TEXT_FIELDS:
        value = row.get(field)
        parsed[field] = value if isinstance(value, str) else None
        if value is not None and not isinstance(value, str):
            bad.append(field)
    return parsed, bad


def _parse_count(raw):
    count, _ = to_number(raw)
    if count is None or count < 0 or not float(count).is_integer():
        raise ValidationError(f"count is not a non-negative whole number: {raw!r}")
    return int(count)


def parse_payload(payload, expected_version=None):
    """Validate a whole Scout response and return parsed objects plus stats."""
    if not isinstance(payload, dict):
        raise ValidationError("payload is not a JSON object")
    # Scout can answer HTTP 200 with an error message instead of data.
    if "error" in payload:
        raise ValidationError(f"Scout returned an error: {payload['error']!r}")
    signature = payload.get("signature")
    if not isinstance(signature, dict):
        raise ValidationError("payload has no signature")
    version = signature.get("version")
    if expected_version is not None and version != expected_version:
        # A new API version may still be compatible, so warn instead of failing.
        log.warning("Scout API version is %r, expected %r", version, expected_version)

    count = _parse_count(payload.get("count"))
    rows = payload.get("data")
    if rows is None and count == 0:  # Scout omits "data" when nothing is listed
        rows = []
    if not isinstance(rows, list):
        raise ValidationError("'data' is missing or not a list")
    if count > 0 and not rows:
        raise ValidationError(f"count is {count} but data is empty")
    if len(rows) != count:
        log.warning("count is %d but data has %d rows", count, len(rows))

    objects, seen = [], set()
    unparseable = failed_values = 0
    for i, row in enumerate(rows):
        name = row.get("objectName") if isinstance(row, dict) else None
        if not isinstance(name, str) or not name.strip():
            log.warning("row %d dropped: not an object or has no objectName", i)
            unparseable += 1
            continue
        parsed, bad = parse_row(row)
        if bad:
            failed_values += len(bad)
            log.warning("%s: could not parse %s; set to null", name, ", ".join(bad))
            if any(field in SCORING_FIELDS for field in bad):
                unparseable += 1
        # History is keyed by objectName, so a duplicate would corrupt it.
        if name in seen:
            log.warning("%s: duplicate objectName; keeping the first row", name)
            continue
        seen.add(name)
        objects.append(parsed)

    if rows and unparseable / len(rows) > MAX_UNPARSEABLE_FRACTION:
        raise ValidationError(f"{unparseable} of {len(rows)} rows are unparseable")

    return {
        "scout_version": version,
        "scout_count": count,
        "objects": objects,
        "stats": {
            "rows": len(rows),
            "unparseable_rows": unparseable,
            "failed_values": failed_values,
        },
    }
