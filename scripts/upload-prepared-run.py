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

Only artifacts referenced by latest.json are uploaded. Old prepared runs are
pruned per timestamped family, keeping referenced runs plus the newest few others so saved
briefings keep their chart images for a while. All revisions within retained runs
are kept, including legacy keys; direct files such as land masks remain unpruned.

Env: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import boto3

REPO = Path(__file__).resolve().parent.parent
RUNS_DIR = REPO / "data" / "processed" / "runs"
PREFIX = "prepared/"
KEEP_UNREFERENCED_RUNS = 6

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


def prune_keys(existing: dict[str, str | None], referenced: set[str]) -> list[str]:
    """Retain references and six unreferenced cycles per family; unknown IDs are safe."""
    families: dict[str, list[tuple[datetime, str]]] = {}
    run_keys: dict[str, list[str]] = {}
    for key in existing:
        # Direct files such as runs/land_mask.json are not run directories.
        parts = key.removeprefix(f"{PREFIX}runs/").split("/", 1)
        if len(parts) != 2 or not parts[1]:
            continue
        run_keys.setdefault(parts[0], []).append(key)
    for run_id in run_keys:
        if run_id in referenced:
            continue
        match = re.fullmatch(r"(.+)-(\d{8}T\d{2}Z)", run_id)
        if match is None:
            continue
        family, stamp = match.groups()
        try:
            timestamp = datetime.strptime(stamp, "%Y%m%dT%HZ")
        except ValueError:
            continue
        families.setdefault(family, []).append((timestamp, run_id))
    doomed = []
    for runs in families.values():
        for _, run_id in sorted(runs, reverse=True)[KEEP_UNREFERENCED_RUNS:]:
            doomed.extend(run_keys[run_id])
    return sorted(doomed)


def main() -> int:
    latest_path = RUNS_DIR / "latest.json"
    if not latest_path.exists():
        print("no data/processed/runs/latest.json — run prepare-run first", file=sys.stderr)
        return 1
    latest_bytes = latest_path.read_bytes()
    latest = json.loads(latest_bytes)
    try:
        pointer_bytes, objects = versioned_publication(latest)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        # Never publish a pointer to missing files or unversioned dependencies.
        print(f"cannot prepare artifact publication, aborting: {exc}", file=sys.stderr)
        return 1

    bucket = os.environ["R2_BUCKET"]
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )

    existing = {}
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=f"{PREFIX}runs/"):
        existing.update({obj["Key"]: obj.get("ETag") for obj in page.get("Contents", [])})

    uploaded = 0
    for rel, body in objects.items():
        key = f"{PREFIX}{rel}"
        # Single-part R2 PUTs have MD5 ETags. Multipart/unknown ETags never
        # compare equal, so conservatively replace rather than skip stale data.
        digest = hashlib.md5(body, usedforsecurity=False).hexdigest()
        remote_etag = existing.get(key)
        if remote_etag is not None and remote_etag.strip('"') == digest:
            continue
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType=content_type(Path(rel)),
            CacheControl=IMMUTABLE,
        )
        uploaded += 1

    # pointer last: readers only see a fully-published run
    s3.put_object(
        Bucket=bucket,
        Key=f"{PREFIX}latest.json",
        Body=pointer_bytes,
        ContentType="application/json",
        CacheControl=POINTER,
    )

    # Only prune after all uploads and the validated pointer have succeeded.
    referenced = {rel.split("/")[1] for rel in objects if rel.startswith("runs/")}
    doomed = prune_keys(existing, referenced)
    for i in range(0, len(doomed), 1000):
        s3.delete_objects(
            Bucket=bucket,
            Delete={"Objects": [{"Key": k} for k in doomed[i : i + 1000]]},
        )

    print(
        f"published run {latest.get('run_id')}: {uploaded} uploaded objects, "
        f"{len(doomed)} pruned, pointer {PREFIX}latest.json updated"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
