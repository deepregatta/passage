"""Offline F01 consumer acceptance; scratch persistence only."""

import hashlib
import importlib.util
import json
import shutil
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def contract(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    import storage_admission

    return storage_admission


class ScratchStore:
    def __init__(self, doc, measured, contract):
        self.objects = {contract.KEY: contract.encode(doc)}
        for owner, size in measured.items():
            prefix = doc["owners"][owner]["prefixes"][0]
            self.objects[prefix + "baseline"] = b"x" * size

    def get_with_etag(self, key):
        raw = self.objects.get(key)
        return raw, hashlib.sha256(raw).hexdigest() if raw is not None else None

    def put(self, key, data, **kwargs):
        if self.get_with_etag(key)[1] != kwargs.get("if_match"):
            raise AssertionError("scratch CAS conflict")
        self.objects[key] = data

    def list_objects(self, prefix):
        return [
            {"key": key, "bytes": len(raw)}
            for key, raw in self.objects.items()
            if key.startswith(prefix)
        ]

    def multipart_bytes(self):
        return 0


@pytest.mark.parametrize("index", range(6))
def test_canonical_vectors(contract, index):
    vectors = json.loads((ROOT / "contracts/storage-admission-v1.vectors.json").read_text())
    case = vectors["cases"][index]
    schema = json.loads((ROOT / "contracts/storage-admission-v1.schema.json").read_text())
    Draft202012Validator(schema).validate(case["document"])
    store = ScratchStore(case["document"], case["measured_bytes"], contract)
    admission = contract.Admission(store, clock=lambda: 100)
    if case["expected"] == "deny":
        with pytest.raises(contract.CapacityDenied):
            admission.acquire(case["writer"], case["name"], case["request_bytes"])
    else:
        reservation = admission.acquire(case["writer"], case["name"], case["request_bytes"])
        document, _ = admission.read()
        assert reservation.bytes == case["request_bytes"]
        assert contract.envelope(document, case["measured_bytes"]) == case["expected_peak_bytes"]


def test_finish_expiry_and_uncertain_retry_never_release_bytes(contract):
    case = json.loads((ROOT / "contracts/storage-admission-v1.vectors.json").read_text())["cases"][
        0
    ]
    store = ScratchStore(case["document"], case["measured_bytes"], contract)
    admission = contract.Admission(store, clock=lambda: 100)
    reservation = admission.acquire("a", "once", 100, seconds=1)
    admission.clock = lambda: 102
    with pytest.raises(contract.CapacityDenied, match="expired"):
        admission.check(reservation)
    admission.finish(reservation)
    admission.finish(reservation)
    doc, _ = admission.read()
    assert doc["reservations"][reservation.token]["bytes"] == 100
    assert doc["reservations"][reservation.token]["state"] == "finished"
    with pytest.raises(contract.CapacityDenied, match="already reserved"):
        admission.acquire("a", "once", 100)
    assert contract.envelope(doc, case["measured_bytes"]) == case["expected_peak_bytes"]


@pytest.mark.parametrize("mutation", ["source", "schema", "missing", "duplicate", "digest_only"])
def test_offline_consistency_rejects_drift(tmp_path, mutation):
    path = ROOT / "scripts/check_storage_admission.py"
    spec = importlib.util.spec_from_file_location("check_storage", path)
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    checker.check(ROOT)
    for relative in [*checker.PATHS, "contracts/storage-admission-v1.lock.json"]:
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
    lock_path = tmp_path / "contracts/storage-admission-v1.lock.json"
    lock = json.loads(lock_path.read_text())
    if mutation == "missing":
        (tmp_path / lock["artifacts"][0]["path"]).unlink()
    elif mutation == "duplicate":
        lock["artifacts"][1] = lock["artifacts"][0]
        lock_path.write_text(json.dumps(lock))
    else:
        row = lock["artifacts"][1 if mutation == "schema" else 0]
        target = tmp_path / row["path"]
        target.write_bytes(target.read_bytes() + b"\n")
        if mutation == "digest_only":
            raw = target.read_bytes().split(b"\n", 1)[1]
            row["sha256"] = hashlib.sha256(raw).hexdigest()
            lock_path.write_text(json.dumps(lock))
    with pytest.raises((ValueError, OSError)):
        checker.check(tmp_path)
