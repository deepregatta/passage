"""Uploader contract tests using an in-memory S3 double."""

import hashlib
import importlib.util
import json
import sys
import threading
from io import BytesIO

from botocore.exceptions import ClientError
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
        self.on_put = lambda key: None
        self.lose_key = None
        self.lock = threading.RLock()
        self.parts_bytes = 0

    def get_paginator(self, name):
        assert name == "list_multipart_uploads"
        return SimpleNamespace(paginate=lambda **kw: [{"IsTruncated": False}])

    def list_objects_v2(self, **kwargs):
        self.on_list()
        with self.lock:
            return {
                "IsTruncated": False,
                "Contents": [
                    {"Key": key, "ETag": obj.get("ETag"), "Size": len(obj.get("Body", b""))}
                    for key, obj in self.objects.items()
                    if key.startswith(kwargs["Prefix"])
                ],
            }

    def get_object(self, **kwargs):
        with self.lock:
            obj = self.objects.get(kwargs["Key"])
            if obj is None:
                raise ClientError(
                    {"Error": {"Code": "NoSuchKey"}, "ResponseMetadata": {"HTTPStatusCode": 404}},
                    "GetObject",
                )
            return {"Body": BytesIO(obj.get("Body", b"")), "ETag": obj.get("ETag")}

    def put_object(self, **kwargs):
        with self.lock:
            key = kwargs["Key"]
            self.calls.append(("put", key))
            if key == self.fail_key:
                raise RuntimeError("upload failed")
            obj = self.objects.get(key)
            if (kwargs.get("IfNoneMatch") == "*" and obj is not None) or (
                "IfMatch" in kwargs and (obj is None or obj.get("ETag") != kwargs["IfMatch"])
            ):
                raise ClientError({"ResponseMetadata": {"HTTPStatusCode": 412}}, "PutObject")
            self.objects[key] = {**kwargs, "ETag": etag(kwargs["Body"])}
            self.on_put(key)
            if key == self.lose_key:
                raise TimeoutError("response lost")
            return {"ETag": self.objects[key]["ETag"]}

    def delete_objects(self, **kwargs):
        raise AssertionError("prepared publication must never delete saved data")


@pytest.fixture
def upload(tmp_path, monkeypatch):
    store = Store()
    monkeypatch.setitem(sys.modules, "boto3", SimpleNamespace(client=lambda *a, **kw: store))
    path = Path(__file__).resolve().parents[2] / "scripts/upload-prepared-run.py"
    monkeypatch.syspath_prepend(str(path.parent))
    spec = importlib.util.spec_from_file_location("upload_prepared_run", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.RUNS_DIR = tmp_path / "runs"
    module.RUNS_DIR.mkdir()
    monkeypatch.setenv("CAPACITY_ENFORCE", "0")
    monkeypatch.setenv("PAID_WORK_ENFORCE", "0")
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


def test_paid_pause_preserves_pointer_and_objects(upload, monkeypatch):
    module, store = upload
    prepare(module, ["runs/ecmwf-ifs025-20261003T00Z/a.json"])
    monkeypatch.setenv("PAID_WORK_ENFORCE", "1")

    def pause():
        raise module.Paused("provider spending limit")

    monkeypatch.setattr(module.Guard, "from_env", lambda: SimpleNamespace(check=pause))
    store.objects["prepared/latest.json"] = {"Body": b"existing readable data"}
    assert module.main() == 0
    assert store.calls == []
    assert store.objects["prepared/latest.json"]["Body"] == b"existing readable data"


def test_offline_saved_briefing_keeps_old_revision_beyond_six_cycles(upload):
    module, store = upload
    prepare(module, ["runs/ecmwf-ifs025-20261003T00Z/a.json"])
    saved = "prepared/runs/ecmwf-ifs025-20260901T00Z/chart.legacy.png"
    store.objects[saved] = {"Body": b"frozen chart", "ETag": etag(b"frozen chart")}
    for day in range(2, 10):
        store.objects[f"prepared/runs/ecmwf-ifs025-202609{day:02}T00Z/a.json"] = {
            "Body": b"old",
            "ETag": etag(b"old"),
        }
    assert module.main() == 0
    assert store.objects[saved]["Body"] == b"frozen chart"
    assert not any(call[0] == "delete" for call in store.calls)


@pytest.mark.parametrize("remote", [b"current", b"obsolete", None])
def test_content_comparison(upload, remote):
    module, store = upload
    rel = "runs/ecmwf-ifs025-20260916T00Z/wind_grid.json"
    pointer = prepare(module, [rel, rel])
    key = "prepared/" + versioned_rel(rel)
    if remote is not None:
        store.objects[key] = {"Body": remote, "ETag": etag(remote)}
    if remote == b"obsolete":
        with pytest.raises(RuntimeError, match="immutable prepared bytes differ"):
            module.main()
        assert store.objects[key]["Body"] == remote
        assert "prepared/latest.json" not in store.objects
        return
    assert module.main() == 0
    assert store.objects[key]["Body"] == b"current"
    assert store.calls.count(("put", key)) == (0 if remote == b"current" else 1)
    assert store.calls[-1] == ("put", "prepared/latest.json")
    expected = json.loads(pointer)
    expected["artifacts"]["files"] = [versioned_rel(rel), versioned_rel(rel)]
    assert published_pointer(store) == expected


@pytest.mark.parametrize("remote_etag", [None, '"multipart-2"', '"opaque"'])
def test_unknown_etag_never_replaces_immutable_bytes(upload, remote_etag):
    module, store = upload
    rel = "runs/ecmwf-ifs025-20260916T00Z/a.json"
    prepare(module, [rel])
    store.objects["prepared/" + versioned_rel(rel)] = {"Body": b"old", "ETag": remote_etag}
    if remote_etag is None:
        assert module.main() == 0  # explicit admission pause, never a publication
    else:
        with pytest.raises(RuntimeError):
            module.main()
    assert store.objects["prepared/" + versioned_rel(rel)]["Body"] == b"old"
    assert not store.calls


def test_retains_all_families_revisions_and_unknown_ids(upload):
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
                assert key in store.objects
    assert all(f"prepared/runs/{run}/a.json" in store.objects for run in unknown)
    pointer_index = store.calls.index(("put", "prepared/latest.json"))
    assert not store.calls[pointer_index + 1 :]


def test_referenced_newest_does_not_consume_unreferenced_allowance(upload):
    module, store = upload
    prepare(module, ["runs/ecmwf-ifs025-20260909T00Z/a.json"])
    for day in range(1, 10):
        store.objects[f"prepared/runs/ecmwf-ifs025-202609{day:02}T00Z/a.json"] = {"ETag": None}
    module.main()
    assert (
        len({key.split("/")[2] for key in store.objects if key.startswith("prepared/runs/")}) == 9
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


def test_large_retention_inventory_is_never_deleted(upload):
    module, store = upload
    prepare(module, [])
    for day in range(1, 9):
        for index in range(501):
            store.objects[f"prepared/runs/ecmwf-ifs025-202609{day:02}T00Z/{index}.json"] = {
                "ETag": None
            }
    module.main()
    assert not any(call[0] == "delete" for call in store.calls)
    assert len(store.objects) == 8 * 501 + 2


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
    from preview_prepared_retention import preview

    module, store = upload
    stamps = [
        "20251231T18Z",
        "20260101T00Z",
        "20260101T06Z",
        "20260101T12Z",
        "20260101T18Z",
        "20260102T00Z",
        "20260102T06Z",
    ]
    store.objects = {
        f"prepared/runs/ecmwf-ifs025-{stamp}/a.json": {"Body": b"saved"}
        for stamp in reversed(stamps)
    }
    report = preview(module.from_env())
    assert [r["key"] for r in report["objects"] if r["age_review_only"]] == [
        "prepared/runs/ecmwf-ifs025-20251231T18Z/a.json"
    ]
    assert report["deletable_keys"] == []
    assert all(r["retain"] for r in report["objects"])


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


def capacity(module, store, *, limit=10**8):
    from storage_admission import Admission, KEY, encode

    transport = module.from_env()
    objects = transport.list_objects("")
    doc = {
        "version": 1,
        "paused": False,
        "rollout_complete": True,
        "epoch": 0,
        "limit_bytes": limit,
        "headroom_bytes": 10,
        "owners": {
            "prepared": {"mode": "managed", "prefixes": ["prepared/"], "ceiling_bytes": 10**8},
            "forecast-root": {
                "mode": "managed",
                "prefixes": ["forecast-runs/"],
                "ceiling_bytes": 10**8,
            },
            "legacy": {
                "mode": "unmanaged",
                "prefixes": ["legacy/", "ops/paid-work.json"],
                "ceiling_bytes": 100,
            },
        },
        "baseline_bytes": {
            "prepared": sum(o["bytes"] for o in objects if o["key"].startswith("prepared/")),
            "forecast-root": sum(
                o["bytes"] for o in objects if o["key"].startswith("forecast-runs/")
            ),
            "legacy": sum(o["bytes"] for o in objects if o["key"].startswith("legacy/")),
        },
        "reservations": {},
        "seen_work": [],
    }
    store.objects[KEY] = {"Body": encode(doc), "ETag": etag(encode(doc))}
    return Admission(transport, conflicts=(module.PreconditionFailed,), clock=lambda: 100)


def wire_peak(module, old=None):
    pointer, objects = module.versioned_publication(
        json.loads((module.RUNS_DIR / "latest.json").read_bytes())
    )
    archives = {module.archive_key(pointer): pointer}
    if old is not None:
        archives[module.archive_key(old)] = old
    return (
        sum(map(len, objects.values()))
        + sum(map(len, archives.values()))
        + module.MUTABLE_UPLOAD_BYTES
    )


def ledger(store):
    from storage_admission import KEY

    return json.loads(store.objects[KEY]["Body"])


@pytest.mark.parametrize("shortfall", [0, 1])
def test_concurrent_forecast_prepared_boundary(upload, shortfall):
    from concurrent.futures import ThreadPoolExecutor
    from storage_admission import CONTROL_BYTES, CapacityDenied

    module, store = upload
    prepare_synoptic_graph(module)
    peak = wire_peak(module)
    admission = capacity(module, store, limit=CONTROL_BYTES + 10 + 100 + peak + 50 - shortfall)
    original_read = admission.read
    barrier = threading.Barrier(2)
    local = threading.local()

    def synchronized_read():
        doc, token = original_read()
        if not getattr(local, "started", False):
            local.started = True
            barrier.wait(timeout=5)
        return doc, token

    admission.read = synchronized_read
    reserved = threading.Barrier(2)
    original_acquire = admission.acquire

    def concurrent_acquire(*args, **kwargs):
        try:
            return original_acquire(*args, **kwargs)
        finally:
            # Both reservations settle before either writer uploads bytes.
            reserved.wait(timeout=5)

    admission.acquire = concurrent_acquire

    def forecast():
        reservation = admission.acquire("forecast-root", "forecast-cycle", 50)
        # Exercise the same adapter used by F01, not an independent byte counter.
        writer = module.ReservedStore(
            admission, reservation, prefix="forecast-runs/", mutable_keys=()
        )
        writer.put(
            "forecast-runs/test/tile",
            b"f" * 50,
            content_type="application/octet-stream",
            cache_control=module.IMMUTABLE,
        )
        admission.finish(reservation)

    with ThreadPoolExecutor(2) as pool:
        jobs = [pool.submit(forecast), pool.submit(module.publish, capacity_admission=admission)]
        outcomes = []
        for job in jobs:
            try:
                job.result(timeout=10)
                outcomes.append("admit")
            except CapacityDenied:
                outcomes.append("deny")
    assert sorted(outcomes) == (["admit", "admit"] if shortfall == 0 else ["admit", "deny"])
    assert sum(r["bytes"] for r in ledger(store)["reservations"].values()) == (
        peak + 50 if shortfall == 0 else (peak if "prepared/latest.json" in store.objects else 50)
    )
    assert not any(call[0] == "delete" for call in store.calls)


def test_full_wire_graph_peak_counts_skipped_legacy_direct_and_interrupted_bytes(upload):
    module, store = upload
    prepare_synoptic_graph(module)
    module.publish()
    old = store.objects[module.LATEST]["Body"]
    store.objects["prepared/runs/land_mask.json"] = {"Body": b"legacy", "ETag": etag(b"legacy")}
    store.objects["prepared/runs/partial-20261001T00Z/orphan"] = {
        "Body": b"unfinished",
        "ETag": etag(b"unfinished"),
    }
    admission = capacity(module, store)
    measured = sum(len(o["Body"]) for k, o in store.objects.items() if k.startswith("prepared/"))
    assert ledger(store)["baseline_bytes"]["prepared"] == measured
    store.calls.clear()
    module.publish(capacity_admission=admission)
    reservations = ledger(store)["reservations"]
    assert [r["bytes"] for r in reservations.values()] == [wire_peak(module, old)]
    assert [r["state"] for r in reservations.values()] == ["finished"]
    assert not any(k.startswith("prepared/runs/") for op, k in store.calls)
    assert store.objects[module.LATEST]["Body"] == old


@pytest.mark.parametrize(
    "failure", ["artifact", "lost_artifact", "pointer", "reservation", "finish"]
)
def test_interruption_and_lost_responses_retain_full_debit(upload, failure):
    from storage_admission import KEY, CapacityDenied

    module, store = upload
    refs = prepare_synoptic_graph(module)
    module.publish()
    old = store.objects[module.LATEST]["Body"]
    chart = refs["synoptic_charts"][0]
    (module.RUNS_DIR.parent / chart).write_bytes(b"changed")
    admission = capacity(module, store)
    peak = wire_peak(module, old)
    store.calls.clear()
    if failure == "artifact":
        store.fail_key = "prepared/" + versioned_rel(chart, b"changed")
    elif failure == "lost_artifact":
        store.lose_key = "prepared/" + versioned_rel(chart, b"changed")
    elif failure == "pointer":
        store.fail_key = module.LATEST
    elif failure == "reservation":
        store.lose_key = KEY
    else:

        def lose_finish(key):
            if key == KEY and len([c for c in store.calls if c == ("put", KEY)]) == 2:
                store.lose_key = KEY

        store.on_put = lose_finish
    with pytest.raises((RuntimeError, CapacityDenied, TimeoutError)):
        module.publish(capacity_admission=admission)
    charges = ledger(store)["reservations"]
    assert len(charges) == 1
    assert sum(r["bytes"] for r in charges.values()) == peak
    assert store.objects[module.LATEST]["Body"] == old or failure == "finish"
    assert not any(c[0] == "delete" for c in store.calls)
    store.lose_key = None
    store.fail_key = None
    store.on_put = lambda key: None
    with pytest.raises(CapacityDenied, match="already reserved"):
        module.publish(capacity_admission=admission)
    assert sum(r["bytes"] for r in ledger(store)["reservations"].values()) == peak


def test_confirmed_lost_pointer_response_preserves_previous_and_exact_old_graph(upload):
    module, store = upload
    refs = prepare_synoptic_graph(module)
    module.publish()
    old = store.objects[module.LATEST]["Body"]
    old_graph = {
        "prepared/" + p: store.objects["prepared/" + p]["Body"]
        for p in module.artifact_paths(json.loads(old))
    }
    (module.RUNS_DIR.parent / refs["synoptic_charts"][0]).write_bytes(b"new chart")
    admission = capacity(module, store)
    store.lose_key = module.LATEST
    assert module.publish(capacity_admission=admission) == 0
    assert store.objects[module.PREVIOUS]["Body"] == old
    assert store.objects[module.archive_key(old)]["Body"] == old
    assert all(store.objects[k]["Body"] == raw for k, raw in old_graph.items())
    assert all(r["state"] == "finished" for r in ledger(store)["reservations"].values())
    saved_chart = json.loads(old)["artifacts"]["synoptic_charts"][0]
    assert store.objects["prepared/" + saved_chart]["Body"] == b"current"
    assert hashlib.sha256(b"current").hexdigest() in saved_chart


@pytest.mark.parametrize(
    "kind", ["unknown_owner", "foreign_growth", "paused", "unconverted", "multipart_unknown"]
)
def test_unknown_state_denies_before_pointer_promotion(upload, kind):
    from storage_admission import KEY, CapacityDenied, encode

    module, store = upload
    prepare(module, ["runs/ecmwf-ifs025-20261003T00Z/a.json"])
    admission = capacity(module, store)
    if kind == "unknown_owner":
        store.objects["unmapped/object"] = {"Body": b"unknown"}
    elif kind == "unconverted":
        store.objects["legacy/excess"] = {"Body": b"x" * 101}
    elif kind == "multipart_unknown":
        admission.store.multipart_bytes = lambda: (_ for _ in ()).throw(TimeoutError())
    elif kind == "paused":
        doc = ledger(store)
        doc["paused"] = True
        store.objects[KEY] = {"Body": encode(doc), "ETag": etag(encode(doc))}
    else:

        def foreign_growth(key):
            if key.startswith("prepared/runs/"):
                store.objects["legacy/excess"] = {"Body": b"x" * 101}

        store.on_put = foreign_growth
    with pytest.raises(CapacityDenied):
        module.publish(capacity_admission=admission)
    assert module.LATEST not in store.objects
    assert not any(c[0] == "delete" for c in store.calls)


def test_retention_preview_protects_current_previous_published_saved_and_unknown(upload):
    from preview_prepared_retention import preview

    module, store = upload
    refs = prepare_synoptic_graph(module)
    module.publish()
    old = store.objects[module.LATEST]["Body"]
    (module.RUNS_DIR.parent / refs["synoptic_charts"][0]).write_bytes(b"new")
    module.publish()
    saved = "runs/legacy/chart.png"
    store.objects["prepared/" + saved] = {"Body": b"saved"}
    store.objects["prepared/runs/unknown/orphan"] = {"Body": b"unknown"}
    report = preview(module.from_env(), saved_references=[saved])
    rows = {r["key"]: r for r in report["objects"]}
    assert rows[module.LATEST]["reasons"] == ["current_pointer", "current_reference"]
    assert (
        "previous_reference"
        in rows["prepared/" + json.loads(old)["artifacts"]["synoptic_charts"][0]]["reasons"]
    )
    assert (
        "archived_reference"
        in rows["prepared/" + json.loads(old)["artifacts"]["wind_grid"]]["reasons"]
    )
    assert rows["prepared/" + saved]["reasons"] == ["declared_saved_reference"]
    assert rows["prepared/runs/unknown/orphan"]["reasons"] == ["unknown_saved_or_offline_owner"]
    assert report["reclaimable_bytes"] == 0 and report["deletable_keys"] == []
    assert not report["offline_ownership_enumerable"]
    assert all(r["retain"] for r in rows.values())


def test_unconfirmed_pointer_response_retains_active_charge(upload):
    module, store = upload
    prepare_synoptic_graph(module)
    module.publish()
    refs = published_pointer(store)["artifacts"]
    (
        module.RUNS_DIR.parent / "runs/ecmwf-ifs025-20260916T00Z/synoptic/charts/t000.png"
    ).write_bytes(b"changed")
    admission = capacity(module, store)
    old_get = store.get_object
    uncertain = False

    def lose_read(key):
        nonlocal uncertain
        if key == module.LATEST:
            uncertain = True
            raise TimeoutError("lost pointer response")

    def unavailable(**kwargs):
        if uncertain and kwargs["Key"] == module.LATEST:
            raise TimeoutError("cannot confirm pointer")
        return old_get(**kwargs)

    store.on_put = lose_read
    store.get_object = unavailable
    with pytest.raises(TimeoutError):
        module.publish(capacity_admission=admission)
    assert all(r["state"] == "active" for r in ledger(store)["reservations"].values())
    assert store.objects["prepared/" + refs["synoptic_charts"][0]]["Body"] == b"current"


def test_concurrent_unconverted_pointer_change_aborts_without_rebase(upload):
    module, store = upload
    prepare_synoptic_graph(module)
    admission = capacity(module, store)
    changed = json.dumps({"run_id": "foreign", "artifacts": {}}).encode()

    def foreign_pointer(key):
        if key.startswith("prepared/runs/"):
            store.objects[module.LATEST] = {"Body": changed, "ETag": etag(changed)}

    store.on_put = foreign_pointer
    with pytest.raises(RuntimeError, match="pointer changed during upload"):
        module.publish(capacity_admission=admission)
    assert store.objects[module.LATEST]["Body"] == changed
    assert module.PREVIOUS not in store.objects
    assert all(r["state"] == "active" for r in ledger(store)["reservations"].values())


@pytest.mark.parametrize("flag", ["missing", "invalid"])
def test_capacity_control_unknown_pauses_before_data_put(upload, monkeypatch, flag):
    module, store = upload
    prepare_synoptic_graph(module)
    monkeypatch.setenv("CAPACITY_ENFORCE", "1" if flag == "missing" else "true")
    assert module.main() == 0
    assert store.calls == []
    assert module.LATEST not in store.objects


@pytest.mark.parametrize(
    "page",
    [
        {},
        {"IsTruncated": True},
        {"IsTruncated": False, "Contents": [{"Key": "prepared/a", "Size": -1}]},
        {"IsTruncated": False, "Contents": [{"Key": "foreign/a", "Size": 1}]},
    ],
)
def test_transport_refuses_incomplete_or_malformed_inventory(upload, page):
    module, store = upload
    store.list_objects_v2 = lambda **kwargs: page
    with pytest.raises((module.CapacityDenied, ValueError)):
        module.from_env().list_objects("prepared/")


def test_transport_counts_pending_parts_and_denies_unknown_pagination(upload):
    module, store = upload

    def paginator(name):
        pages = (
            [
                {
                    "IsTruncated": False,
                    "Uploads": [{"Key": "prepared/partial", "UploadId": "scratch"}],
                }
            ]
            if name == "list_multipart_uploads"
            else [
                {
                    "IsTruncated": False,
                    "Parts": [{"PartNumber": 1, "Size": 19}, {"PartNumber": 2, "Size": 20}],
                }
            ]
        )
        return SimpleNamespace(paginate=lambda **kw: pages)

    store.get_paginator = paginator
    assert module.from_env().multipart_bytes() == 39
    store.get_paginator = lambda name: SimpleNamespace(paginate=lambda **kw: [{}])
    with pytest.raises(module.CapacityDenied, match="multipart pagination unknown"):
        module.from_env().multipart_bytes()


def test_retention_preview_unreadable_ownership_remains_retained(upload):
    from preview_prepared_retention import preview

    module, store = upload
    store.objects[module.LATEST] = {
        "Body": b"corrupted pointer",
        "ETag": etag(b"corrupted pointer"),
    }
    store.objects["prepared/runs/legacy/chart.png"] = {"Body": b"saved"}
    result = preview(module.from_env())
    assert result["unreadable_reference_documents"] == 1
    assert result["deletable_keys"] == []
    assert all(r["retain"] for r in result["objects"])


def test_guard_denial_is_not_settled_as_a_lost_pointer_response(upload):
    module, store = upload
    prepare_synoptic_graph(module)
    module.publish()
    old = store.objects[module.LATEST]["Body"]
    writes = []

    class RefusingStore:
        def put(self, *args, **kwargs):
            writes.append(args[0])
            raise module.CapacityDenied("operator pause")

        def get_with_etag(self, key):
            raise AssertionError("guard denial must never use transport settlement")

    with pytest.raises(module.CapacityDenied, match="operator pause"):
        module.commit_pointer(RefusingStore(), module.LATEST, old, etag(old))
    assert writes == [module.LATEST]


def test_capacity_pause_preserves_paid_work_start_runtime_and_finishes_only_lease(
    upload, monkeypatch
):
    module, store = upload
    local_pointer = prepare(module, ["runs/ecmwf-ifs025-20261003T00Z/a.json"])
    events = []
    guard = SimpleNamespace(
        check=lambda: events.append("review"),
        acquire=lambda channel, work, seconds: (
            events.append((channel, work, seconds)) or "paid-token"
        ),
        finish=lambda channel, token: events.append(("finish", channel, token)),
    )
    monkeypatch.setattr(module.Guard, "from_env", lambda: guard)
    monkeypatch.setenv("PAID_WORK_ENFORCE", "1")
    monkeypatch.setenv("CAPACITY_ENFORCE", "1")
    assert module.main() == 0  # capacity ledger missing, after paid-work reservation
    assert events == [
        "review",
        ("prepared", hashlib.sha256(local_pointer).hexdigest(), 2700),
        ("finish", "prepared", "paid-token"),
    ]
    assert store.calls == []
    assert module.LATEST not in store.objects
