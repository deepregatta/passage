#!/usr/bin/env python3
"""Publish the local prepared run (data/processed/runs/) to R2 under prepared/.

The viewer resolves `runs/…` artifact paths against
`${VITE_FORECAST_BASE_URL}/prepared/` in production (viewer/src/lib/preparedRun.js),
so the object layout mirrors the local one exactly:

    prepared/runs/<run_id>/…      1y cache (forced regeneration may replace content)
    prepared/latest.json          5 min cache, uploaded LAST (publish marker)

Only artifacts referenced by latest.json are uploaded. Old prepared runs are
pruned per timestamped family, keeping referenced runs plus the newest few others so saved
briefings keep their chart images for a while.

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
    rels = list(dict.fromkeys(artifact_paths(latest)))
    missing = [rel for rel in rels if not (RUNS_DIR.parent / rel).exists()]
    if missing:
        # never publish a pointer to artifacts that are not all present
        print(f"latest.json references missing files, aborting: {missing}", file=sys.stderr)
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
    for rel in rels:
        key = f"{PREFIX}{rel}"
        file_path = RUNS_DIR.parent / rel
        body = file_path.read_bytes()
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
            ContentType=content_type(file_path),
            CacheControl=IMMUTABLE,
        )
        uploaded += 1

    # pointer last: readers only see a fully-published run
    s3.put_object(
        Bucket=bucket,
        Key=f"{PREFIX}latest.json",
        Body=latest_bytes,
        ContentType="application/json",
        CacheControl=POINTER,
    )

    # Only prune after all uploads and the validated pointer have succeeded.
    referenced = {rel.split("/")[1] for rel in rels if rel.startswith("runs/")}
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
