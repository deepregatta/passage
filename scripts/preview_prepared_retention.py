#!/usr/bin/env python3
"""Read-only retention preview. Unknown offline owners prevent all automatic pruning."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from collections import Counter
from datetime import datetime
from pathlib import Path

from prepared_storage import from_env

CURRENT = "prepared/latest.json"
PREVIOUS = "prepared/previous.json"


def references(doc):
    refs = set()
    if not isinstance(doc, dict) or not isinstance(doc.get("artifacts"), dict):
        raise ValueError("invalid prepared reference document")
    for value in doc["artifacts"].values():
        for path in value if isinstance(value, list) else [value]:
            if isinstance(path, str) and path.startswith("runs/"):
                refs.add("prepared/" + path)
    return refs


def preview(store, *, saved_references=()):
    objects = store.list_objects("prepared/")
    protected = {CURRENT: {"current_pointer"}, PREVIOUS: {"previous_pointer"}}
    unreadable = 0
    for key, reason in [(CURRENT, "current_reference"), (PREVIOUS, "previous_reference")] + [
        (obj["key"], "archived_reference")
        for obj in objects
        if obj["key"].startswith("prepared/pointers/")
    ]:
        protected.setdefault(key, set()).add("pointer_archive" if "pointers/" in key else reason)
        try:
            raw, _ = store.get_with_etag(key)
            if raw is not None:
                for ref in references(json.loads(raw)):
                    protected.setdefault(ref, set()).add(reason)
        except Exception:
            unreadable += 1  # unavailable ownership never authorizes pruning
    for path in saved_references:
        if not isinstance(path, str) or not path.startswith("runs/") or ".." in path.split("/"):
            raise ValueError("invalid saved prepared artifact path")
        protected.setdefault("prepared/" + path, set()).add("declared_saved_reference")

    families = {}
    for obj in objects:
        parts = obj["key"].split("/", 3)
        if len(parts) != 4 or parts[1] != "runs":
            continue
        match = re.fullmatch(r"(.+)-(\d{8}T\d{2}Z)", parts[2])
        if match is not None:
            family, stamp = match.groups()
            try:
                date = datetime.strptime(stamp, "%Y%m%dT%HZ")
            except ValueError:
                continue
            families.setdefault(family, {})[parts[2]] = date
    review_runs = {
        run
        for runs in families.values()
        for run, _ in sorted(runs.items(), key=lambda item: item[1], reverse=True)[6:]
    }
    rows = []
    for obj in objects:
        key = obj["key"]
        reasons = sorted(protected.get(key, {"unknown_saved_or_offline_owner"}))
        parts = key.split("/", 3)
        rows.append(
            {
                "key": key,
                "bytes": obj["bytes"],
                "retain": True,
                "reasons": reasons,
                "age_review_only": len(parts) == 4 and parts[2] in review_runs,
                "legacy_or_direct": key.startswith("prepared/runs/")
                and not re.search(r"\.[0-9a-f]{64}\.[^/]+$", key),
            }
        )
    return {
        "version": 1,
        "preview_only": True,
        "offline_ownership_enumerable": False,
        "objects": sorted(rows, key=lambda row: row["key"]),
        "physical_prepared_bytes": sum(row["bytes"] for row in rows),
        "unreadable_reference_documents": unreadable,
        "deletable_keys": [],
        "reclaimable_bytes": 0,
        "reason_counts": dict(Counter(reason for row in rows for reason in row["reasons"])),
    }


class ReadOnlyDirectory:
    def __init__(self, root):
        if not root.is_dir():
            raise ValueError("scratch inventory directory unavailable")
        self.root = root

    def list_objects(self, prefix):
        return [
            {"key": p.relative_to(self.root).as_posix(), "bytes": p.stat().st_size}
            for p in self.root.rglob("*")
            if p.is_file() and p.relative_to(self.root).as_posix().startswith(prefix)
        ]

    def get_with_etag(self, key):
        path = self.root / key
        raw = path.read_bytes() if path.is_file() else None
        return raw, hashlib.sha256(raw).hexdigest() if raw is not None else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, help="scratch object directory instead of R2")
    parser.add_argument("--references", type=Path, help="private explicit prepared-path inventory")
    parser.add_argument(
        "--output", type=Path, help="private preview file, created exclusively mode 0600"
    )
    args = parser.parse_args()
    saved = ()
    if args.references:
        document = json.loads(args.references.read_text())
        if set(document) != {"version", "prepared_artifact_paths"} or document["version"] != 1:
            raise ValueError("unsupported explicit reference inventory")
        saved = document["prepared_artifact_paths"]
        if not isinstance(saved, list):
            raise ValueError("reference inventory must be a list")
    result = preview(
        ReadOnlyDirectory(args.dir) if args.dir else from_env(), saved_references=saved
    )
    if args.output:
        with os.fdopen(
            os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
        ) as out:
            json.dump(result, out, indent=2)
            out.write("\n")
    print(json.dumps({k: v for k, v in result.items() if k != "objects" and k != "deletable_keys"}))


if __name__ == "__main__":
    main()
