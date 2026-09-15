"""Atomic, serialized updates to the local prepared-run pointer (POSIX)."""

from __future__ import annotations

import fcntl
import json
import os
import tempfile
from pathlib import Path
from typing import Any


def update_latest(
    runs_dir: Path, run_id: str | None, new_artifacts: dict[str, Any]
) -> dict[str, Any]:
    """Merge artifacts, optionally set run_id, and replace latest.json atomically.

    A stable sidecar lock serializes cooperating local publishers across the
    entire read/merge/replace operation. Never unlink the lock: waiting writers
    must continue to lock the same inode. Readers need no lock. Missing pointers
    start empty; unreadable or malformed pointers fail without losing content.
    This is local publication, not a lock for remote object-storage uploads.
    """
    runs_dir.mkdir(parents=True, exist_ok=True)
    latest_path = runs_dir / "latest.json"
    with (runs_dir / ".latest.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            latest = json.loads(latest_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            latest = {}
        if not isinstance(latest, dict) or not isinstance(latest.get("artifacts", {}), dict):
            raise ValueError(
                f"Invalid pointer structure in {latest_path}; refusing to overwrite it"
            )
        if run_id is not None:
            latest["run_id"] = run_id
        latest.setdefault("artifacts", {}).update(new_artifacts)
        payload = json.dumps(latest, indent=2) + "\n"
        temporary_path = None
        try:
            # Same directory guarantees that replacement stays on one filesystem.
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=runs_dir,
                prefix=".latest-",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                temporary.write(payload)
                temporary.flush()
                os.fsync(temporary.fileno())
                # Match the readable published artifacts (NamedTemporaryFile uses 0600).
                os.fchmod(temporary.fileno(), 0o644)
            os.replace(temporary_path, latest_path)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
        return latest
