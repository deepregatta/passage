#!/usr/bin/env python3
"""Verify the pinned F01 bundle offline, without a sibling checkout or network."""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REVISION = "036dc0bd406844fea4ca0c02ef34de1f64370e79"
PATHS = {
    "scripts/storage_admission.py": "src/ingest/storage_admission.py",
    **{
        f"contracts/storage-admission-v1.{suffix}": f"contracts/storage-admission-v1.{suffix}"
        for suffix in ("schema.json", "example.json", "vectors.json")
    },
}


def check(root=ROOT):
    lock = json.loads((root / "contracts/storage-admission-v1.lock.json").read_text())
    if (
        lock["version"] != 1
        or lock["canonical_repository"] != "deepregatta/forecast-tiles"
        or lock["canonical_revision"] != REVISION
    ):
        raise ValueError("unexpected storage contract provenance")
    rows = lock["artifacts"]
    if len(rows) != len(PATHS) or {r["path"] for r in rows} != set(PATHS):
        raise ValueError("storage contract inventory changed")
    for row in rows:
        path = row["path"]
        if row["canonical_path"] != PATHS[path]:
            raise ValueError("canonical path changed")
        raw = (root / path).read_bytes()
        if path.endswith(".py"):
            header = (
                f"# Vendored from forecast-tiles {PATHS[path]}, 2026-10-04, revision {REVISION}.\n"
            ).encode()
            if not raw.startswith(header):
                raise ValueError("vendor provenance changed")
            raw = raw[len(header) :]
        blob = (
            "git-blob:"
            + hashlib.sha1(
                b"blob " + str(len(raw)).encode() + b"\0" + raw, usedforsecurity=False
            ).hexdigest()
        )
        if blob != row["canonical_blob"] or hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise ValueError(f"storage admission drift: {path}")
    print(f"PASS storage admission v1: {len(rows)} canonical artifacts at {REVISION}")


if __name__ == "__main__":
    check()
