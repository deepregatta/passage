"""Shared artifact checksums and lazy NetCDF readers.

Extracted from the local ECMWF and vendored environment/ERA5 modules.
"""

import hashlib
from pathlib import Path
from typing import Any


def compute_file_checksum(file_path: Path) -> str:
    """Stream a file's SHA256 using the artifact metadata's sha256:<hex> format."""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            sha256.update(chunk)
    return f"sha256:{sha256.hexdigest()}"


def check_xarray() -> bool:
    """Check if xarray can be imported, preserving optional-reader degradation."""
    try:
        import xarray  # noqa: F401

        return True
    except ImportError:
        return False


def open_nc_robust(path: Path) -> Any:
    """Try netcdf4 then h5netcdf; the caller owns and closes the returned dataset."""
    import xarray as xr

    last_exc: Exception = RuntimeError("No engines available")
    for engine in ("netcdf4", "h5netcdf"):
        try:
            return xr.open_dataset(path, engine=engine)
        except Exception as exc:
            last_exc = exc
    raise last_exc
