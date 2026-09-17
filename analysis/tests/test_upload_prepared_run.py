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


def versioned_rel(rel, body=b"current"):
    path = Path(rel)
    return str(path.with_name(f"{path.stem}.{hashlib.sha256(body).hexdigest()}{path.suffix}"))


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
    key = "prepared/" + versioned_rel(rel)
    if remote is not None:
        store.objects[key] = {"Body": remote, "ETag": etag(remote)}
    assert module.main() == 0
    assert store.objects[key]["Body"] == b"current"
    assert store.calls.count(("put", key)) == (0 if remote == b"current" else 1)
    assert store.calls[-1] == ("put", "prepared/latest.json")
    expected = json.loads(pointer)
    expected["artifacts"]["files"] = [versioned_rel(rel), versioned_rel(rel)]
    assert published_pointer(store) == expected


@pytest.mark.parametrize("remote_etag", [None, '"multipart-2"', '"opaque"'])
def test_unverifiable_etag_is_uploaded(upload, remote_etag):
    module, store = upload
    rel = "runs/ecmwf-ifs025-20260916T00Z/a.json"
    prepare(module, [rel])
    store.objects["prepared/" + versioned_rel(rel)] = {"Body": b"old", "ETag": remote_etag}
    module.main()
    assert store.objects["prepared/" + versioned_rel(rel)]["Body"] == b"current"


def test_prunes_each_family_and_preserves_references_and_unknown_ids(upload):
    module, store = upload
    families = ["ecmwf-ifs025", "cmems-channel", "cmems-biscay"]
    prepare(module, [f"runs/{family}-20260901T00Z/a.json" for family in families])
    for family in families:
        for day in range(1, 10):
            for filename in ("a.json", "b.png", versioned_rel("b.png")):
                key = f"prepared/runs/{family}-202609{day:02}T00Z/{filename}"
                store.objects[key] = {"Body": b"old", "ETag": etag(b"old")}
    unknown = ["legacy", "land-v1", "ecmwf-ifs025-20269999T00Z"]
    for run in unknown:
        store.objects[f"prepared/runs/{run}/a.json"] = {"ETag": None}
    module.main()
    for family in families:
        for day in range(1, 10):
            for filename in ("b.png", versioned_rel("b.png")):
                key = f"prepared/runs/{family}-202609{day:02}T00Z/{filename}"
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
    assert (
        len({key.split("/")[2] for key in store.objects if key.startswith("prepared/runs/")}) == 7
    )


@pytest.mark.parametrize("failure", ["missing", "artifact", "pointer"])
def test_failure_does_not_prune_or_publish_incomplete_pointer(upload, failure):
    module, store = upload
    rel = "runs/ecmwf-ifs025-20260916T00Z/a.json"
    prepare(module, [rel])
    if failure == "missing":
        (module.RUNS_DIR.parent / rel).unlink()
        assert module.main() == 1
    else:
        store.fail_key = (
            "prepared/" + versioned_rel(rel) if failure == "artifact" else "prepared/latest.json"
        )
        with pytest.raises(RuntimeError, match="upload failed"):
            module.main()
    assert not any(call[0] == "delete" for call in store.calls)
    assert "prepared/latest.json" not in store.objects


def test_pointer_uses_validated_snapshot(upload):
    module, store = upload
    original = prepare(module, ["runs/ecmwf-ifs025-20260916T00Z/a.json"])
    store.on_list = lambda: (module.RUNS_DIR / "latest.json").write_text('{"artifacts": {}}')
    module.main()
    expected = json.loads(original)
    expected["artifacts"]["files"] = [versioned_rel(rel) for rel in expected["artifacts"]["files"]]
    assert published_pointer(store) == expected


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


def published_pointer(store):
    return json.loads(store.objects["prepared/latest.json"]["Body"])


def test_changed_artifact_bypasses_warm_immutable_cache(upload):
    module, store = upload
    rel = "runs/ecmwf-ifs025-20260916T00Z/wind_grid.json"
    local_pointer = prepare(module, [rel])
    # A browser/CDN still has the legacy URL, even if its origin was repaired.
    cache = {"prepared/" + rel: b"obsolete"}
    store.objects["prepared/" + rel] = {"Body": b"obsolete", "ETag": etag(b"obsolete")}

    def read(path):
        key = "prepared/" + path
        return cache.setdefault(key, store.objects[key]["Body"])

    module.main()
    first = published_pointer(store)["artifacts"]["files"][0]
    assert read(first) == b"current"
    assert first != rel
    (module.RUNS_DIR.parent / rel).write_bytes(b"regenerated")
    module.main()
    second = published_pointer(store)["artifacts"]["files"][0]
    assert second != first
    assert read(second) == b"regenerated"
    assert read(first) == b"current"  # saved briefings retain their revision
    assert store.objects["prepared/" + rel]["Body"] == b"obsolete"
    assert (module.RUNS_DIR / "latest.json").read_bytes() == local_pointer
    assert store.objects["prepared/" + second]["CacheControl"] == module.IMMUTABLE
    assert store.objects["prepared/latest.json"]["CacheControl"] == module.POINTER


def prepare_synoptic_graph(module):
    root = "runs/ecmwf-ifs025-20260916T00Z"
    refs = {
        "synoptic_features": f"{root}/synoptic/features.json",
        "synoptic_charts": [f"{root}/synoptic/charts/t000.png"],
        "wind_grid": f"{root}/wind_grid.json",
        "current_grid": "runs/cmems-channel-20260916T00Z/current_grid.json",
        "land_mask": "runs/land_mask.json",
        "run_manifest": f"{root}/run.json",
    }
    prepare(
        module,
        [
            refs["synoptic_features"],
            *refs["synoptic_charts"],
            refs["wind_grid"],
            refs["current_grid"],
            refs["land_mask"],
            refs["run_manifest"],
        ],
    )
    features = {
        "run_id": root.split("/")[1],
        "chart_captions": [
            {"file": refs["synoptic_charts"][0], "caption": "Original caption", "step_h": 0},
        ],
    }
    manifest = {
        "run_id": features["run_id"],
        "artifacts": {key: value for key, value in refs.items() if key != "run_manifest"},
    }
    pointer = {"run_id": features["run_id"], "artifacts": refs, "metadata": "preserved"}
    for rel, value in [
        (refs["synoptic_features"], features),
        (refs["run_manifest"], manifest),
        ("runs/latest.json", pointer),
    ]:
        (module.RUNS_DIR.parent / rel).write_text(json.dumps(value))
    return refs


def test_embedded_chart_and_manifest_references_are_versioned(upload):
    module, store = upload
    refs = prepare_synoptic_graph(module)
    originals = {path: path.read_bytes() for path in module.RUNS_DIR.rglob("*") if path.is_file()}
    module.main()
    first = published_pointer(store)
    paths = first["artifacts"]
    assert first["metadata"] == "preserved"
    for rel in module.artifact_paths(first):
        obj = store.objects["prepared/" + rel]
        assert hashlib.sha256(obj["Body"]).hexdigest() in rel
    features = json.loads(store.objects["prepared/" + paths["synoptic_features"]]["Body"])
    manifest = json.loads(store.objects["prepared/" + paths["run_manifest"]]["Body"])
    assert features["chart_captions"][0]["file"] == paths["synoptic_charts"][0]
    assert features["chart_captions"][0]["caption"] == "Original caption"
    assert manifest["artifacts"] == {k: v for k, v in paths.items() if k != "run_manifest"}
    assert all(path.read_bytes() == body for path, body in originals.items())
    (module.RUNS_DIR.parent / refs["synoptic_charts"][0]).write_bytes(b"new chart")
    module.main()
    revised = published_pointer(store)["artifacts"]
    for role in ("synoptic_features", "synoptic_charts", "run_manifest"):
        assert revised[role] != paths[role]  # chart dependency changes its parents too
    for role in ("wind_grid", "current_grid", "land_mask"):
        assert revised[role] == paths[role]
    assert store.objects["prepared/" + paths["synoptic_charts"][0]]["Body"] == b"current"
    assert store.objects["prepared/" + revised["synoptic_charts"][0]]["ContentType"] == "image/png"


def test_upload_uses_same_artifact_bytes_as_hash_when_local_files_change(upload):
    module, store = upload
    rel = "runs/ecmwf-ifs025-20260916T00Z/a.json"
    prepare(module, [rel])
    store.on_list = lambda: (module.RUNS_DIR.parent / rel).write_bytes(b"concurrent edit")
    module.main()
    published = published_pointer(store)["artifacts"]["files"][0]
    body = store.objects["prepared/" + published]["Body"]
    assert body == b"current"
    assert hashlib.sha256(body).hexdigest() in published


def test_unpublished_embedded_reference_aborts_before_any_upload(upload):
    module, store = upload
    refs = prepare_synoptic_graph(module)
    path = module.RUNS_DIR.parent / refs["synoptic_features"]
    path.write_text(json.dumps({"chart_captions": [{"file": "runs/missing/chart.png"}]}))
    assert module.main() == 1
    assert store.calls == []


@pytest.mark.parametrize("failure", ["artifact", "pointer"])
def test_failed_revision_preserves_previous_pointer_and_objects(upload, failure):
    module, store = upload
    refs = prepare_synoptic_graph(module)
    module.main()
    previous = dict(store.objects)
    chart = refs["synoptic_charts"][0]
    (module.RUNS_DIR.parent / chart).write_bytes(b"revised chart")
    store.fail_key = (
        "prepared/" + versioned_rel(chart, b"revised chart")
        if failure == "artifact"
        else "prepared/latest.json"
    )
    store.calls.clear()
    with pytest.raises(RuntimeError, match="upload failed"):
        module.main()
    assert all(store.objects[key] == obj for key, obj in previous.items())
    assert not any(call[0] == "delete" for call in store.calls)


def test_real_synoptic_output_preserves_contracts_and_repeats_without_upload(upload, monkeypatch):
    from jsonschema import Draft202012Validator
    from test_synoptic_prep import synthetic_dataset, synthetic_meta

    from deepweather_analysis import synoptic_prep
    from deepweather_analysis.paths import contracts_dir

    module, store = upload
    root = module.RUNS_DIR.parent
    module.RUNS_DIR = root / "processed" / "runs"
    monkeypatch.setenv("DEEPWEATHER_DATA_ROOT", str(root))
    monkeypatch.setattr(
        synoptic_prep,
        "fetch_fields",
        lambda *a, **kw: (
            synthetic_dataset(),
            synthetic_meta(),
        ),
    )
    synoptic_prep.prepare_synoptic(panel_steps=(0, 3))
    original = json.loads((module.RUNS_DIR / "latest.json").read_text())
    assert module.main() == 0
    refs = published_pointer(store)["artifacts"]
    for role, schema in [
        ("synoptic_features", "synoptic-features.schema.json"),
        ("run_manifest", "prepared-run.schema.json"),
        ("wind_grid", "region-grid.schema.json"),
    ]:
        published = json.loads(store.objects["prepared/" + refs[role]]["Body"])
        Draft202012Validator(json.loads((contracts_dir() / schema).read_text())).validate(published)
        local = json.loads((module.RUNS_DIR.parent / original["artifacts"][role]).read_text())
        # Metadata, geometry, science values and provenance stay identical.
        for field in local.keys() - {"artifacts", "chart_captions"}:
            assert published[field] == local[field]
        if role == "synoptic_features":
            for old, new in zip(local["chart_captions"], published["chart_captions"], strict=True):
                assert {k: v for k, v in old.items() if k != "file"} == {
                    k: v for k, v in new.items() if k != "file"
                }
                assert (
                    store.objects["prepared/" + new["file"]]["Body"]
                    == (module.RUNS_DIR.parent / old["file"]).read_bytes()
                )
    pointer = store.objects["prepared/latest.json"]["Body"]
    store.calls.clear()
    assert module.main() == 0
    assert store.calls == [("put", "prepared/latest.json")]
    assert store.objects["prepared/latest.json"]["Body"] == pointer
