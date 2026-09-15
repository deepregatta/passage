"""Uploader contract tests using an in-memory S3 double."""

import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


def etag(body):
    return '"' + hashlib.md5(body, usedforsecurity=False).hexdigest() + '"'


class Store:
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.fail_key = None
        self.on_list = lambda: None

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return self

    def paginate(self, **kwargs):
        self.on_list()
        for key, obj in list(self.objects.items()):
            if key.startswith(kwargs["Prefix"]):
                yield {"Contents": [{"Key": key, "ETag": obj["ETag"]}]}
        yield {}

    def put_object(self, **kwargs):
        self.calls.append(("put", kwargs["Key"]))
        if kwargs["Key"] == self.fail_key:
            raise RuntimeError("upload failed")
        self.objects[kwargs["Key"]] = {**kwargs, "ETag": etag(kwargs["Body"])}

    def delete_objects(self, **kwargs):
        keys = [obj["Key"] for obj in kwargs["Delete"]["Objects"]]
        assert len(keys) <= 1000
        self.calls.append(("delete", keys))
        for key in keys:
            del self.objects[key]


@pytest.fixture
def upload(tmp_path, monkeypatch):
    store = Store()
    monkeypatch.setitem(sys.modules, "boto3", SimpleNamespace(client=lambda *a, **kw: store))
    path = Path(__file__).resolve().parents[2] / "scripts/upload-prepared-run.py"
    spec = importlib.util.spec_from_file_location("upload_prepared_run", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.RUNS_DIR = tmp_path / "runs"
    module.RUNS_DIR.mkdir()
    for name in ("R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(name, "test")
    return module, store


def prepare(module, rels):
    body = json.dumps({"run_id": "test", "artifacts": {"files": rels}}).encode()
    (module.RUNS_DIR / "latest.json").write_bytes(body)
    for rel in rels:
        path = module.RUNS_DIR.parent / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"current")
    return body


@pytest.mark.parametrize("remote", [b"current", b"obsolete", None])
def test_content_comparison(upload, remote):
    module, store = upload
    rel = "runs/ecmwf-ifs025-20260916T00Z/wind_grid.json"
    pointer = prepare(module, [rel, rel])
    key = "prepared/" + rel
    if remote is not None:
        store.objects[key] = {"Body": remote, "ETag": etag(remote)}
    assert module.main() == 0
    assert store.objects[key]["Body"] == b"current"
    assert store.calls.count(("put", key)) == (0 if remote == b"current" else 1)
    assert store.calls[-1] == ("put", "prepared/latest.json")
    assert store.objects["prepared/latest.json"]["Body"] == pointer


@pytest.mark.parametrize("remote_etag", [None, '"multipart-2"', '"opaque"'])
def test_unverifiable_etag_is_uploaded(upload, remote_etag):
    module, store = upload
    rel = "runs/ecmwf-ifs025-20260916T00Z/a.json"
    prepare(module, [rel])
    store.objects["prepared/" + rel] = {"Body": b"old", "ETag": remote_etag}
    module.main()
    assert store.objects["prepared/" + rel]["Body"] == b"current"


def test_prunes_each_family_and_preserves_references_and_unknown_ids(upload):
    module, store = upload
    families = ["ecmwf-ifs025", "cmems-channel", "cmems-biscay"]
    prepare(module, [f"runs/{family}-20260901T00Z/a.json" for family in families])
    for family in families:
        for day in range(1, 10):
            for filename in ("a.json", "b.png"):
                key = f"prepared/runs/{family}-202609{day:02}T00Z/{filename}"
                store.objects[key] = {"Body": b"old", "ETag": etag(b"old")}
    unknown = ["legacy", "land-v1", "ecmwf-ifs025-20269999T00Z"]
    for run in unknown:
        store.objects[f"prepared/runs/{run}/a.json"] = {"ETag": None}
    module.main()
    for family in families:
        for day in range(1, 10):
            key = f"prepared/runs/{family}-202609{day:02}T00Z/b.png"
            assert (key in store.objects) == (day == 1 or day >= 4)
    assert all(f"prepared/runs/{run}/a.json" in store.objects for run in unknown)
    pointer_index = store.calls.index(("put", "prepared/latest.json"))
    assert all(call[0] == "delete" for call in store.calls[pointer_index + 1 :])


def test_referenced_newest_does_not_consume_unreferenced_allowance(upload):
    module, store = upload
    prepare(module, ["runs/ecmwf-ifs025-20260909T00Z/a.json"])
    for day in range(1, 10):
        store.objects[f"prepared/runs/ecmwf-ifs025-202609{day:02}T00Z/a.json"] = {"ETag": None}
    module.main()
    assert len([key for key in store.objects if key.startswith("prepared/runs/")]) == 7


@pytest.mark.parametrize("failure", ["missing", "artifact", "pointer"])
def test_failure_does_not_prune_or_publish_incomplete_pointer(upload, failure):
    module, store = upload
    rel = "runs/ecmwf-ifs025-20260916T00Z/a.json"
    prepare(module, [rel])
    if failure == "missing":
        (module.RUNS_DIR.parent / rel).unlink()
        assert module.main() == 1
    else:
        store.fail_key = "prepared/" + rel if failure == "artifact" else "prepared/latest.json"
        with pytest.raises(RuntimeError, match="upload failed"):
            module.main()
    assert not any(call[0] == "delete" for call in store.calls)
    assert "prepared/latest.json" not in store.objects


def test_pointer_uses_validated_snapshot(upload):
    module, store = upload
    original = prepare(module, ["runs/ecmwf-ifs025-20260916T00Z/a.json"])
    store.on_list = lambda: (module.RUNS_DIR / "latest.json").write_text('{"artifacts": {}}')
    module.main()
    assert store.objects["prepared/latest.json"]["Body"] == original


def test_delete_batches(upload):
    module, store = upload
    prepare(module, [])
    for day in range(1, 9):
        for index in range(501):
            store.objects[f"prepared/runs/ecmwf-ifs025-202609{day:02}T00Z/{index}.json"] = {
                "ETag": None
            }
    module.main()
    assert [len(call[1]) for call in store.calls if call[0] == "delete"] == [1000, 2]


def test_repeat_upload_skips_artifacts_and_preserves_direct_files(upload):
    module, store = upload
    prepare(module, ["runs/ecmwf-ifs025-20260916T00Z/a.json", "runs/land_mask.json"])
    store.objects["prepared/runs/unreferenced.json"] = {"ETag": None}
    module.main()
    store.calls.clear()
    module.main()
    assert store.calls == [("put", "prepared/latest.json")]
    assert "prepared/runs/unreferenced.json" in store.objects


def test_pruning_uses_cycle_chronology(upload):
    module, _ = upload
    stamps = [
        "20251231T18Z",
        "20260101T00Z",
        "20260101T06Z",
        "20260101T12Z",
        "20260101T18Z",
        "20260102T00Z",
        "20260102T06Z",
    ]
    existing = {f"prepared/runs/ecmwf-ifs025-{stamp}/a.json": None for stamp in reversed(stamps)}
    assert module.prune_keys(existing, set()) == ["prepared/runs/ecmwf-ifs025-20251231T18Z/a.json"]
