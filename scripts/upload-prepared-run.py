#!/usr/bin/env python3
"""Publish the local prepared run (data/processed/runs/) to R2 under prepared/.

The viewer resolves `runs/…` artifact paths against
`${VITE_FORECAST_BASE_URL}/prepared/` in production (viewer/src/lib/preparedRun.js),
so publication preserves the runs/<run_id>/ layout but versions each filename:

    prepared/runs/<run_id>/…<sha256>.<ext>  1y immutable cache
    prepared/latest.json          5 min cache, uploaded LAST (publish marker)

Hashes cover the uploaded bytes, including rewritten chart/manifest references.
Local files are unchanged. On the first publication after migration, even unchanged
artifacts get new URLs, bypassing legacy immutable browser/CDN entries without a
purge. Existing clients adopt these URLs when they next load latest.json (currently
once per page load, with up to its 5 min HTTP cache lifetime). Already-open pages
and saved briefings keep their original references; legacy URLs are not repaired.

Only artifacts referenced by latest.json are uploaded. Historical artifacts and
pointer archives are retained: offline/local/shared references cannot be enumerated
centrally. scripts/preview_prepared_retention.py is read-only; no automatic pruning.

A run that produced no current grid (the CMEMS step failed or was skipped; the
job's runner starts with no local pointer) carries the live pointer's
`current_grid` reference over, unchanged, while that grid's own time axis still
reaches CARRIED_CURRENT_MIN_HOURS past upload time. The pointer then records it
in the optional `current_grid_carried_over` field and the job gets a warning.
Anything unusable or unreadable publishes without a current grid, as before. A
run that produced a grid publishes exactly the pointer it always did.

Env: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET; optional
CURRENTS_OUTCOME (the currents step's outcome) and GITHUB_STEP_SUMMARY.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath

from paid_work import Guard, Paused, RuntimeExpired, deadline, enforced
from prepared_storage import PreconditionFailed, from_env
from storage_admission import (
    ATTEMPTS,
    MUTABLE_UPLOAD_BYTES,
    Admission,
    CapacityDenied,
    ReservedStore,
    enforced as capacity_enforced,
)

REPO = Path(__file__).resolve().parent.parent
RUNS_DIR = REPO / "data" / "processed" / "runs"
PREFIX = "prepared/"
LATEST = PREFIX + "latest.json"
PREVIOUS = PREFIX + "previous.json"

IMMUTABLE = "public, max-age=31536000, immutable"
POINTER = "public, max-age=300, must-revalidate"

# A carried-over current grid must still cover this long after upload time. The
# factory's grid spans 168 h from its fetch hour (grids_prep.DEFAULT_WINDOW_HOURS;
# 120 h until 2026-11-13), so a grid stays carried for about 120 h, many missed
# runs at the job's real roughly twice-daily success cadence. The factory
# publishes no fresh grid shorter than this either (grids_prep.MIN_PUBLISHED_HOURS:
# a product ending that early fails the currents step, and this rule then judges
# the live grid). 48 h is the shortest horizon the router plans a passage over
# (engine passageMaxHours), so a carried grid can still cover a typical Channel
# passage departing now. The viewer still admits it per
# route and departure time (engine currentGridCovers).
CARRIED_CURRENT_MIN_HOURS = 48
CARRIED = "current_grid_carried_over"
CURRENTS_OUTCOMES = {
    "failure": "currents step failed",
    "cancelled": "currents step cancelled",
    "skipped": "currents step skipped",
}
NO_CURRENT_GRID = "no current grid produced"


def content_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def unsafe_rel(rel) -> bool:
    return (
        not isinstance(rel, str)
        or not rel.startswith("runs/")
        or ".." in PurePosixPath(rel).parts
        or "\\" in rel
        or rel != str(PurePosixPath(rel))
    )


def encode(doc: dict) -> bytes:
    return (json.dumps(doc, separators=(",", ":")) + "\n").encode()


def artifact_paths(latest: dict) -> list[str]:
    rels: list[str] = []
    for value in latest.get("artifacts", {}).values():
        if isinstance(value, str):
            rels.append(value)
        elif isinstance(value, list):
            rels.extend(v for v in value if isinstance(v, str))
    return rels


def versioned_publication(latest: dict) -> tuple[bytes, dict[str, bytes]]:
    """Snapshot local bytes and rewrite the publication graph before any R2 writes."""
    artifacts = latest.get("artifacts", {})
    rels = dict.fromkeys(artifact_paths(latest))
    if any(unsafe_rel(rel) for rel in rels):
        raise ValueError("artifact path outside prepared runs")
    bodies = {rel: (RUNS_DIR.parent / rel).read_bytes() for rel in rels}
    versions: dict[str, str] = {}
    objects: dict[str, bytes] = {}

    def add(rel: str, body: bytes) -> None:
        path = Path(rel)
        digest = hashlib.sha256(body).hexdigest()
        version = str(path.with_name(f"{path.stem}.{digest}{path.suffix}"))
        versions[rel] = version
        objects[version] = body

    def reference(rel: str) -> str:
        if rel not in versions:
            raise ValueError(f"unpublished artifact reference: {rel}")
        return versions[rel]

    def rewrite_artifacts(refs: dict) -> dict:
        rewritten = {}
        for name, value in refs.items():
            if isinstance(value, str):
                value = reference(value)
            elif isinstance(value, list):
                value = [reference(v) if isinstance(v, str) else v for v in value]
            rewritten[name] = value
        return rewritten

    features_rel = artifacts.get("synoptic_features")
    manifest_rel = artifacts.get("run_manifest")
    # Dependencies first: chart bytes -> feature captions -> run manifest -> pointer.
    for rel, body in bodies.items():
        if rel not in (features_rel, manifest_rel):
            add(rel, body)
    if features_rel is not None:
        features = json.loads(bodies[features_rel])
        for caption in features.get("chart_captions", []):
            caption["file"] = reference(caption["file"])
        add(features_rel, encode(features))
    if manifest_rel is not None:
        manifest = json.loads(bodies[manifest_rel])
        manifest["artifacts"] = rewrite_artifacts(manifest.get("artifacts", {}))
        add(manifest_rel, encode(manifest))
    return encode({**latest, "artifacts": rewrite_artifacts(artifacts)}), objects


def produced_current_grid(latest: dict) -> bool:
    return isinstance(latest.get("artifacts", {}).get("current_grid"), str)


def currents_reason() -> str:
    return CURRENTS_OUTCOMES.get(os.environ.get("CURRENTS_OUTCOME", ""), NO_CURRENT_GRID)


def parse_utc(value) -> datetime:
    if not isinstance(value, str):
        raise TypeError("time is not a string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("time has no UTC offset")
    return parsed.astimezone(timezone.utc)


def live_current_grid(store, live: bytes | None, now: datetime):
    """Judge the live pointer's current grid: (carried, why, had_grid).

    `carried` is (reference, grid run id, time axis end) of a usable grid, else
    None with `why` naming the cause; `had_grid` is False when there was no
    regional grid to keep at all. Usability is read from the grid object itself:
    it must exist, match the digest in its immutable name, be a surface current
    grid and have a time axis that reaches CARRIED_CURRENT_MIN_HOURS past `now`.
    No Exception escapes (any doubt drops the grid, as every run without a grid
    did before); the deadline's RuntimeExpired is a BaseException and does.
    """
    try:
        return judge_live_grid(store, live, now)
    except Exception as exc:
        return None, f"it could not be judged ({type(exc).__name__})", True


def judge_live_grid(store, live, now):
    if live is None:
        return None, "there is no live pointer", False
    ref = json.loads(live)["artifacts"].get("current_grid")
    if ref is None:
        return None, "the live pointer has no current grid", False
    if unsafe_rel(ref):
        return None, "its reference is malformed", True
    digest = PurePosixPath(ref).stem.rpartition(".")[2]
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        return None, "its reference carries no digest", True
    try:
        body, _ = store.get_with_etag(PREFIX + ref)
    except Exception as exc:  # transport, oversize or token problems: drop, never block
        return None, f"its object could not be read ({type(exc).__name__})", True
    if body is None:
        return None, "its object is missing", True
    if hashlib.sha256(body).hexdigest() != digest:
        return None, "its bytes do not match its reference", True
    try:
        grid = json.loads(body)
        axis = grid["time_axis"]
        if not isinstance(axis, list) or not axis or not all(isinstance(t, str) for t in axis):
            raise ValueError("time axis is not a non-empty list of strings")
        end = max(parse_utc(t) for t in axis)
    except Exception:  # includes OverflowError and RecursionError on hostile bytes
        return None, "it has no readable time axis", True
    if grid.get("kind") != "surface_current":
        return None, "it is not a surface current grid", True
    run_id = grid.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        return None, "its run id is unreadable", True
    end_text = end.strftime("%Y-%m-%dT%H:%M:%SZ")
    if end < now + timedelta(hours=CARRIED_CURRENT_MIN_HOURS):
        return (
            None,
            (
                f"grid {run_id} time axis ends {end_text}, less than "
                f"{CARRIED_CURRENT_MIN_HOURS} h after this upload"
            ),
            True,
        )
    return (ref, run_id, end_text), None, True


def with_carried_grid(pointer_bytes: bytes, carried, reason: str) -> bytes:
    ref, run_id, end = carried
    doc = json.loads(pointer_bytes)
    doc["artifacts"]["current_grid"] = ref
    doc[CARRIED] = {"grid_run_id": run_id, "time_axis_end": end, "reason": reason}
    return encode(doc)


def workflow_escape(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def report_currents(message: str, *, annotate: bool = True) -> None:
    """A GitHub Actions warning plus a job-summary line, or a plain notice line.

    Never raises: the pointer may already be committed when this runs.
    """
    try:
        # Grid text comes from stored bytes; keep it printable in any encoding.
        message = message.encode("ascii", "backslashreplace").decode("ascii")
        if not annotate:
            print(f"prepared currents: {message}", flush=True)
            return
        print(f"::warning title=Prepared currents::{workflow_escape(message)}", flush=True)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as handle:
                handle.write(f"- {message}\n")
    except Exception as exc:
        try:
            print(f"currents report not written: {type(exc).__name__}", file=sys.stderr)
        except Exception:
            pass


def currents_message(reason: str, carried, why: str | None, had_grid: bool) -> str:
    head = f"No current grid was produced this run ({reason})."
    if carried is not None:
        _, run_id, end = carried
        return (
            f"{head} Carried over the previous regional grid {run_id}: its time axis ends "
            f"{end}, at least {CARRIED_CURRENT_MIN_HOURS} h after this upload."
        )
    lead = "The previous regional grid was dropped" if had_grid else "No regional grid to keep"
    return f"{head} {lead}: {why}. The site uses tile currents until a run produces a grid."


def report_outcome(carried, why, had_grid) -> None:
    # A credential-less setup (step skipped, nothing ever published) stays quiet,
    # as before; anything carried or dropped is always a warning.
    quiet = currents_reason() == CURRENTS_OUTCOMES["skipped"] and not had_grid
    report_currents(currents_message(currents_reason(), carried, why, had_grid), annotate=not quiet)


def local_grid_missing() -> bool:
    try:
        return not produced_current_grid(json.loads((RUNS_DIR / "latest.json").read_bytes()))
    except (OSError, ValueError, AttributeError):
        return False  # no readable local run: publish() reports that itself


def archive_key(body: bytes) -> str:
    return f"{PREFIX}pointers/{hashlib.sha256(body).hexdigest()}.json"


def put_immutable(store, key, body, *, content_type):
    existing, _ = store.get_with_etag(key)
    if existing is not None:
        if existing != body:
            raise RuntimeError("immutable prepared bytes differ; publication refused")
        return False
    try:
        store.put(
            key,
            body,
            content_type=content_type,
            cache_control=IMMUTABLE,
            if_none_match=True,
        )
    except PreconditionFailed:
        # Only a definite conflict may be settled as identical content. Unknown
        # write outcomes stop the publication; its reservation remains charged.
        if store.get_with_etag(key)[0] != body:
            raise RuntimeError("immutable prepared conflict; publication refused")
        return False
    return True


def commit_pointer(store, key, body, etag):
    try:
        store.put(
            key,
            body,
            content_type="application/json",
            cache_control=POINTER,
            if_match=etag,
            if_none_match=etag is None,
        )
    except CapacityDenied:
        raise  # a guard refusal is not a lost transport response
    except Exception:
        # An authenticated GET can confirm a committed but lost response.
        # Anything else stops: no retry against a changed base and no cleanup.
        if store.get_with_etag(key)[0] != body:
            raise


def main() -> int:
    guard = None
    token = None
    progress: dict = {}
    try:
        if enforced():
            guard = Guard.from_env()
            guard.check()
            pointer = (RUNS_DIR / "latest.json").read_bytes()
            # Content changes still obey frequency/runtime limits. Exact retries
            # are denied, including re-runs after an uncertain upload outcome.
            token = guard.acquire("prepared", hashlib.sha256(pointer).hexdigest(), 2700)
            with deadline(2700):
                return publish(progress=progress)
        return publish(progress=progress)
    except (Paused, RuntimeExpired, CapacityDenied) as exc:
        print(f"prepared production paused: {exc}; existing data remains available")
        # After the pointer commit, publish() has already reported what it published.
        if not progress.get("committed") and local_grid_missing():
            report_currents(
                f"No current grid was produced this run ({currents_reason()}). "
                "Publication paused, so nothing was carried over or dropped: "
                "the live pointer and its current grid are unchanged.",
                annotate=currents_reason() != CURRENTS_OUTCOMES["skipped"],
            )
        return 0
    finally:
        if guard and token:
            try:
                guard.finish("prepared", token)
            except Paused as exc:
                print(f"prepared lease retained until expiry: {exc}")


def publish(*, store=None, capacity_admission=None, progress=None) -> int:
    latest_path = RUNS_DIR / "latest.json"
    if not latest_path.exists():
        print(
            "no data/processed/runs/latest.json — run prepare-run first",
            file=sys.stderr,
        )
        return 1
    latest = json.loads(latest_path.read_bytes())
    try:
        pointer_bytes, objects = versioned_publication(latest)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"cannot prepare artifact publication, aborting: {exc}", file=sys.stderr)
        return 1

    store = store or (capacity_admission.store if capacity_admission is not None else from_env())
    # Snapshot the entire wire graph before inventory, reservations or writes.
    store.list_objects(PREFIX)
    old, old_etag = store.get_with_etag(LATEST)
    previous, previous_etag = store.get_with_etag(PREVIOUS)
    for body in (old, previous):
        if body is not None:
            doc = json.loads(body)
            if not isinstance(doc, dict) or not isinstance(doc.get("artifacts"), dict):
                raise RuntimeError("prepared pointer invalid; retain data and review")
    # A run without a current grid keeps the live one while that grid is still
    # usable. The carried object already exists, immutable and never pruned, so
    # nothing is uploaded or reserved for it. A run with a grid is untouched.
    carried = why = None
    had_grid = False
    if not produced_current_grid(latest):
        carried, why, had_grid = live_current_grid(store, old, utcnow())
        if carried is not None:
            pointer_bytes = with_carried_grid(pointer_bytes, carried, currents_reason())
    if ATTEMPTS * (len(pointer_bytes) + len(old or b"")) > MUTABLE_UPLOAD_BYTES:
        raise CapacityDenied("prepared pointer attempts exceed reserved control allowance")

    archives = {archive_key(pointer_bytes): pointer_bytes}
    if old is not None:
        archives[archive_key(old)] = old
    # Reserve full graph bytes even for skipped immutable objects. Baselines
    # count all earlier revisions, legacy/direct files and incomplete uploads.
    # Archive bytes plus bounded current/previous attempts cover control peaks.
    peak = sum(map(len, objects.values())) + sum(map(len, archives.values())) + MUTABLE_UPLOAD_BYTES
    admission = capacity_admission
    if admission is None and capacity_enforced():
        admission = Admission(store, conflicts=(PreconditionFailed,))
    reservation = None
    writer = store
    if admission is not None:
        reservation = admission.acquire(
            "prepared",
            hashlib.sha256(pointer_bytes).hexdigest(),
            peak,
            seconds=2700,
        )
        writer = ReservedStore(
            admission, reservation, prefix=PREFIX, mutable_keys=(LATEST, PREVIOUS)
        )

    uploaded = 0
    for rel, body in objects.items():
        uploaded += put_immutable(
            writer, f"{PREFIX}{rel}", body, content_type=content_type(Path(rel))
        )
    for key, body in archives.items():
        put_immutable(writer, key, body, content_type="application/json")

    # Verify the base before moving previous. Current remains the final publish
    # marker, conditional on the original base; an unconverted writer can cause
    # refusal, never deletion or rebase onto an unreviewed graph.
    if store.get_with_etag(LATEST) != (old, old_etag):
        raise RuntimeError("prepared pointer changed during upload; publication refused")
    if old is not None and old != pointer_bytes:
        commit_pointer(writer, PREVIOUS, old, previous_etag)
    commit_pointer(writer, LATEST, pointer_bytes, old_etag)
    if progress is not None:
        progress["committed"] = True
    if not produced_current_grid(latest):
        report_outcome(carried, why, had_grid)  # before anything that may still pause
    if reservation is not None:
        admission.finish(reservation)  # diagnostic only; never releases its bytes
    print(
        f"published run {latest.get('run_id')}: {uploaded} uploaded artifacts, "
        f"historical data retained, pointer {LATEST} confirmed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
