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

Env: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import sys
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


def content_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


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
    if any(
        not rel.startswith("runs/")
        or ".." in PurePosixPath(rel).parts
        or "\\" in rel
        or rel != str(PurePosixPath(rel))
        for rel in rels
    ):
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

    def encode(doc: dict) -> bytes:
        return (json.dumps(doc, separators=(",", ":")) + "\n").encode()

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
    try:
        if enforced():
            guard = Guard.from_env()
            guard.check()
            pointer = (RUNS_DIR / "latest.json").read_bytes()
            # Content changes still obey frequency/runtime limits. Exact retries
            # are denied, including re-runs after an uncertain upload outcome.
            token = guard.acquire("prepared", hashlib.sha256(pointer).hexdigest(), 2700)
            with deadline(2700):
                return publish()
        return publish()
    except (Paused, RuntimeExpired, CapacityDenied) as exc:
        print(f"prepared production paused: {exc}; existing data remains available")
        return 0
    finally:
        if guard and token:
            try:
                guard.finish("prepared", token)
            except Paused as exc:
                print(f"prepared lease retained until expiry: {exc}")


def publish(*, store=None, capacity_admission=None) -> int:
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
    if reservation is not None:
        admission.finish(reservation)  # diagnostic only; never releases its bytes
    print(
        f"published run {latest.get('run_id')}: {uploaded} uploaded artifacts, "
        f"historical data retained, pointer {LATEST} confirmed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
