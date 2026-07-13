#!/usr/bin/env python3
"""Publish the local prepared run (data/processed/runs/) to R2 under prepared/.

The viewer resolves `runs/…` artifact paths against
`${VITE_FORECAST_BASE_URL}/prepared/` in production (viewer/src/lib/preparedRun.js),
so the object layout mirrors the local one exactly:

    prepared/runs/<run_id>/…      immutable, 1y cache
    prepared/latest.json          5 min cache, uploaded LAST (publish marker)

Only artifacts referenced by latest.json are uploaded. Old prepared runs are
pruned, keeping the referenced ones plus the newest few so recently saved
briefings keep their chart images for a while.

Env: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
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


def main() -> int:
    latest_path = RUNS_DIR / "latest.json"
    if not latest_path.exists():
        print("no data/processed/runs/latest.json — run prepare-run first", file=sys.stderr)
        return 1
    latest = json.loads(latest_path.read_text())
    rels = artifact_paths(latest)
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

    existing = set()
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=f"{PREFIX}runs/"):
        existing.update(obj["Key"] for obj in page.get("Contents", []))

    uploaded = 0
    for rel in rels:
        key = f"{PREFIX}{rel}"
        if key in existing:
            continue  # run artifacts are immutable once written
        file_path = RUNS_DIR.parent / rel
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=file_path.read_bytes(),
            ContentType=content_type(file_path),
            CacheControl=IMMUTABLE,
        )
        uploaded += 1

    # pointer last: readers only see a fully-published run
    s3.put_object(
        Bucket=bucket,
        Key=f"{PREFIX}latest.json",
        Body=latest_path.read_bytes(),
        ContentType="application/json",
        CacheControl=POINTER,
    )

    # prune: keep runs referenced by latest.json plus the newest few others
    referenced = {rel.split("/")[1] for rel in rels if rel.startswith("runs/")}
    run_ids = sorted({key.split("/")[2] for key in existing if key.count("/") >= 3}, reverse=True)
    keep = referenced | set(run_ids[:KEEP_UNREFERENCED_RUNS])
    doomed = [key for key in existing if key.split("/")[2] not in keep]
    for i in range(0, len(doomed), 1000):
        s3.delete_objects(
            Bucket=bucket,
            Delete={"Objects": [{"Key": k} for k in doomed[i : i + 1000]]},
        )

    print(
        f"published run {latest.get('run_id')}: {uploaded} new objects, "
        f"{len(doomed)} pruned, pointer {PREFIX}latest.json updated"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
