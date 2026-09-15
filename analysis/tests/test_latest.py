"""Pointer publication must preserve the old complete document until replacement."""

import json
import multiprocessing
from pathlib import Path

import pytest

from deepweather_analysis.latest import update_latest
from deepweather_analysis import latest as latest_module


def test_failed_serialization_preserves_pointer(tmp_path):
    pointer = tmp_path / "latest.json"
    original = '{"run_id": "old", "artifacts": {"land_mask": "runs/land_mask.json"}}\n'
    pointer.write_text(original)
    with pytest.raises(TypeError):
        update_latest(tmp_path, "new", {"wind_grid": object()})
    assert pointer.read_text() == original


@pytest.mark.parametrize("original", ['{"artifacts":', "", "[]", '{"artifacts": []}'])
def test_invalid_pointer_is_not_overwritten(tmp_path, original):
    pointer = tmp_path / "latest.json"
    pointer.write_text(original)
    with pytest.raises(ValueError):
        update_latest(tmp_path, "new", {"wind_grid": "runs/new/wind_grid.json"})
    assert pointer.read_text() == original


def test_pointer_is_never_opened_for_writing(tmp_path, monkeypatch):
    pointer = tmp_path / "latest.json"
    pointer.write_text('{"run_id": "old", "artifacts": {}}\n')
    real_open = Path.open

    def checked_open(path, mode="r", *args, **kwargs):
        assert path != pointer or not any(flag in mode for flag in "wax+"), (
            "Readers could observe a truncated pointer"
        )
        return real_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", checked_open)
    update_latest(tmp_path, "new", {"wind_grid": "runs/new/wind_grid.json"})
    assert json.loads(pointer.read_text())["run_id"] == "new"


def test_merge_and_optional_run_id(tmp_path):
    pointer = tmp_path / "latest.json"
    pointer.write_text(json.dumps({"run_id": "old", "extra": [1], "artifacts": {"land": "a"}}))
    result = update_latest(tmp_path, "new", {"wind": "b"})
    assert result == {"run_id": "new", "extra": [1], "artifacts": {"land": "a", "wind": "b"}}
    assert pointer.read_text() == json.dumps(result, indent=2) + "\n"
    result = update_latest(tmp_path, None, {"land": "c"})
    assert result["run_id"] == "new"
    assert result["artifacts"] == {"land": "c", "wind": "b"}


def test_create_missing_pointer_and_directory(tmp_path):
    runs = tmp_path / "runs"
    assert update_latest(runs, None, {"land": "a"}) == {"artifacts": {"land": "a"}}
    assert (runs / "latest.json").stat().st_mode & 0o777 == 0o644


@pytest.mark.parametrize("operation", ["fsync", "replace"])
def test_failed_publication_preserves_pointer_and_cleans_temp(tmp_path, monkeypatch, operation):
    pointer = tmp_path / "latest.json"
    original = '{"run_id": "old", "artifacts": {}}\n'
    pointer.write_text(original)

    def fail(*args):
        assert pointer.read_text() == original
        if operation == "replace":
            source, destination = args
            assert source.parent == destination.parent == tmp_path
            assert json.loads(source.read_text())["run_id"] == "new"
        raise OSError("injected publication failure")

    monkeypatch.setattr(latest_module.os, operation, fail)
    with pytest.raises(OSError, match="injected"):
        update_latest(tmp_path, "new", {"wind": "b"})
    assert pointer.read_text() == original
    assert not list(tmp_path.glob(".latest-*.tmp"))


def test_read_error_is_not_treated_as_missing(tmp_path, monkeypatch):
    pointer = tmp_path / "latest.json"
    pointer.write_text('{"artifacts": {}}')
    real_read = Path.read_text

    def fail(path, *args, **kwargs):
        if path == pointer:
            raise PermissionError("injected read failure")
        return real_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", fail)
    with pytest.raises(PermissionError, match="injected"):
        update_latest(tmp_path, "new", {})
    assert real_read(pointer) == '{"artifacts": {}}'


def _publish_many(runs, barrier, worker):
    barrier.wait(timeout=20)
    for i in range(10):
        update_latest(runs, None, {f"{worker}-{i}": "x" * 4096})
        # Exercise a lock-free reader while other processes publish.
        assert json.loads((runs / "latest.json").read_text())["run_id"] == "seed"


def test_concurrent_publishers_keep_all_entries(tmp_path):
    update_latest(tmp_path, "seed", {"land": "a"})
    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(4)
    workers = [context.Process(target=_publish_many, args=(tmp_path, barrier, i)) for i in range(4)]
    try:
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=30)
            assert worker.exitcode == 0
    finally:
        for worker in workers:
            if worker.is_alive():
                worker.terminate()
                worker.join(timeout=5)
    result = json.loads((tmp_path / "latest.json").read_text())
    assert result["artifacts"] == {"land": "a"} | {
        f"{worker}-{i}": "x" * 4096 for worker in range(4) for i in range(10)
    }
    assert not list(tmp_path.glob(".latest-*.tmp"))
