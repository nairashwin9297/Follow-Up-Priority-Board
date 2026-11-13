"""Snapshot history per object. Pure functions: no file I/O (main.py does that).

An object that drops off Scout's list is only "last seen" at some time. We
can't know why it left, so nothing here says "confirmed" or "resolved".
"""
import copy
from datetime import timedelta

from .parse import from_iso, to_iso

RETENTION_DAYS = 30
SNAPSHOT_FIELDS = ("nObs", "arc", "unc", "uncP1", "neoScore")


def empty_history():
    return {"schema_version": 1, "objects": {}}


def update_history(history, objects, now):
    """Return a new history with this run's objects added and old ones pruned."""
    # Work on a copy so a failure later in the run can't leave half-updated state.
    updated = copy.deepcopy(history)
    entries = updated["objects"]
    now_iso = to_iso(now)

    for obj in objects:
        entry = entries.setdefault(
            obj["objectName"], {"first_seen": now_iso, "last_seen": now_iso, "snapshots": []}
        )
        entry["last_seen"] = now_iso
        t = obj["lastRun"]
        # Scout re-runs an object every so often; (objectName, lastRun) identifies one run.
        # With no lastRun there is nothing to key on, so we record presence but no snapshot.
        if t is not None and all(s["t"] != t for s in entry["snapshots"]):
            entry["snapshots"].append({"t": t, **{f: obj[f] for f in SNAPSHOT_FIELDS}})

    cutoff = now - timedelta(days=RETENTION_DAYS)
    updated["objects"] = {
        name: entry for name, entry in entries.items() if from_iso(entry["last_seen"]) >= cutoff
    }
    return updated
