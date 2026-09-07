"""Tidal predictions at reference ports — HW/LW series.

Modes (config/providers.json "tides"); the live source is per-route, from
config/route-sources.json tides.live_source.kind:

live / noaa_coops — NOAA CO-OPS official harmonic predictions
  (api.tidesandcurrents.noaa.gov, product=predictions&interval=hilo): HW/LW
  events directly from the authority, heights in metres above MLLW (the US
  chart datum) — no extraction or datum transfer needed. US routes.

live / qld_msq — Maritime Safety Queensland official predictions on the
  Queensland open-data portal (data.qld.gov.au CKAN): per-gauge yearly
  "predicted high/low" CSVs, resolved by package name at fetch time so a new
  year is picked up automatically. HW/LW events directly from the authority,
  heights in metres above LAT (the QLD chart datum); times arrive in AEST
  (UTC+10, Queensland keeps no DST) and are converted via the route's
  utc_offset_hours. Australian routes.

live / cmems_ssh — CMEMS regional-model sea-surface height (variable zos).
  Default dataset is the IBI 15-minute 2D SSH
  (cmems_mod_ibi_phy_anfc_0.027deg-2D_PT15M-i); routes outside IBI declare a
  sibling dataset in route-sources.json tides.live_source.dataset (e.g. the
  Med model's cmems_mod_med_phy-ssh_anfc_4.2km_PT15M-i — recent Med versions
  carry explicit tides, proven by the detided sibling dataset). The models
  carry tidal forcing, so their SSH series contains the real tide; HW/LW are
  extracted at the nearest wet grid cell to each reference port.
  Heights are model SSH (≈ above mean sea level) shifted by the port's Z0
  (mean level above chart datum) as an approximate datum transfer — good for
  gate *timing*, indicative only for heights. Any fetch failure degrades to
  the synthetic path below so the artifact stays honestly badged.

synthetic — harmonic synthesis with plausible-but-NOT-surveyed constituents:
  h(t) = Z0 + Σ A_i · cos(ω_i·t − φ_i) over M2/S2/N2/K1/O1; downstream
  evidence is badged "emulated" and the briefing carries a disclosure section.

Both paths find HW/LW as sign changes of dh/dt on a regular grid, refined by
a local quadratic fit.
"""

from __future__ import annotations

import json
import logging
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .paths import contracts_dir, data_root, processed_dir
from .providers import Mode, provider_mode
from .route_sources import load_route_sources, tide_ports, tides_artifact_name, tides_live_source
from .timeutil import parse_iso_utc

logger = logging.getLogger(__name__)

CMEMS_SSH_DATASET = os.environ.get(
    "DEEPWEATHER_CMEMS_TIDES_DATASET", "cmems_mod_ibi_phy_anfc_0.027deg-2D_PT15M-i"
)
# half-width of the per-port subset box, degrees (~8 nm) — enough to find a wet cell
PORT_BOX_HALF_DEG = 0.14

COOPS_URL = os.environ.get(
    "DEEPWEATHER_COOPS_URL", "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
)

# angular speeds, degrees per hour (standard values)
OMEGA = {"M2": 28.9841042, "S2": 30.0, "N2": 28.4397295, "K1": 15.0410686, "O1": 13.9430356}

# Reference ports come from config/route-sources.json per route. SYNTHETIC
# constituent amplitudes (m) / phases (deg) there are plausible for each
# region's character (large semidiurnal, marked spring/neap) but are NOT
# surveyed values. Z0 = mean level above chart datum. PORTS is the default
# route's registry, kept for direct callers/tests.
PORTS: dict[str, dict] = tide_ports()

EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


def height_m(port_id: str, when: datetime, *, ports: dict[str, dict] | None = None) -> float:
    port = (ports or PORTS)[port_id]
    hours = (when - EPOCH).total_seconds() / 3600.0
    h = port["z0"]
    for name, (amp, phase) in port["constituents"].items():
        h += amp * math.cos(math.radians(OMEGA[name] * hours - phase))
    return h


def hw_lw_events(
    port_id: str, start: datetime, end: datetime, *, ports: dict[str, dict] | None = None
) -> list[dict]:
    """HW/LW via derivative sign change on a 6-min grid + quadratic refinement."""

    def _h(when: datetime) -> float:
        return height_m(port_id, when, ports=ports)

    events = []
    step = timedelta(minutes=6)
    t = start
    prev_h = _h(t - step)
    cur_h = _h(t)
    while t <= end:
        next_h = _h(t + step)
        rising_before = cur_h > prev_h
        rising_after = next_h > cur_h
        if rising_before != rising_after:
            # quadratic vertex through the three samples for sub-step timing
            denom = prev_h - 2 * cur_h + next_h
            offset_frac = 0.5 * (prev_h - next_h) / denom if abs(denom) > 1e-9 else 0.0
            t_ext = t + step * max(-1.0, min(1.0, offset_frac))
            events.append(
                {
                    "kind": "HW" if rising_before else "LW",
                    "time": t_ext.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "height_m": round(_h(t_ext), 2),
                }
            )
        prev_h, cur_h = cur_h, next_h
        t += step
    return events


def _events_from_samples(times_ms: list[float], heights: list[float]) -> list[dict]:
    """HW/LW from a regularly sampled series: slope sign change + quadratic vertex."""
    events = []
    for i in range(1, len(heights) - 1):
        prev_h, cur_h, next_h = heights[i - 1], heights[i], heights[i + 1]
        rising_before = cur_h > prev_h
        rising_after = next_h > cur_h
        if rising_before == rising_after:
            continue
        step_ms = (times_ms[i + 1] - times_ms[i - 1]) / 2.0
        denom = prev_h - 2 * cur_h + next_h
        offset_frac = 0.5 * (prev_h - next_h) / denom if abs(denom) > 1e-9 else 0.0
        offset_frac = max(-1.0, min(1.0, offset_frac))
        t_ext = times_ms[i] + step_ms * offset_frac
        # height at the quadratic vertex
        h_ext = cur_h - 0.25 * (prev_h - next_h) * offset_frac
        events.append(
            {
                "kind": "HW" if rising_before else "LW",
                "time": datetime.fromtimestamp(t_ext / 1000.0, tz=timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
                "height_m": round(h_ext, 2),
            }
        )
    return events


def _fetch_port_ssh_events(
    port_id: str, port: dict, start: datetime, end: datetime, dataset_id: str
) -> list[dict]:
    """Live path: subset CMEMS SSH around one port, extract HW/LW at nearest wet cell."""
    import copernicusmarine
    import numpy as np
    import xarray as xr

    cache_dir = data_root() / "cache" / "tides"
    cache_dir.mkdir(parents=True, exist_ok=True)
    nc_path = cache_dir / f"{port_id}.nc"
    copernicusmarine.subset(
        dataset_id=dataset_id,
        variables=["zos"],
        minimum_longitude=port["lon"] - PORT_BOX_HALF_DEG,
        maximum_longitude=port["lon"] + PORT_BOX_HALF_DEG,
        minimum_latitude=port["lat"] - PORT_BOX_HALF_DEG,
        maximum_latitude=port["lat"] + PORT_BOX_HALF_DEG,
        start_datetime=start.strftime("%Y-%m-%dT%H:%M:%S"),
        end_datetime=end.strftime("%Y-%m-%dT%H:%M:%S"),
        output_directory=str(cache_dir),
        output_filename=nc_path.name,
        overwrite=True,
    )
    with xr.open_dataset(nc_path) as ds:
        zos = ds["zos"]
        wet = ~np.isnan(zos.isel(time=0).values)
        if not wet.any():
            raise RuntimeError(f"no wet cells within {PORT_BOX_HALF_DEG}° of {port_id}")
        lats = ds["latitude"].values
        lons = ds["longitude"].values
        cos_lat = math.cos(math.radians(port["lat"]))
        lat_grid, lon_grid = np.meshgrid(lats, lons, indexing="ij")
        dist2 = (lat_grid - port["lat"]) ** 2 + ((lon_grid - port["lon"]) * cos_lat) ** 2
        dist2[~wet] = np.inf
        i, j = np.unravel_index(int(np.argmin(dist2)), dist2.shape)
        series = zos.values[:, i, j].astype(float)
        times_ms = ds["time"].values.astype("datetime64[ms]").astype(float).tolist()
    if np.isnan(series).any():
        raise RuntimeError(f"NaN in SSH series at {port_id}")
    # approximate chart-datum transfer: model SSH (~MSL) + port mean level above CD
    heights = [h + port["z0"] for h in series.tolist()]
    return _events_from_samples(times_ms, heights)


def _coops_events_from_json(data: dict, start: datetime, end: datetime) -> list[dict]:
    """Schema events from a CO-OPS predictions&interval=hilo JSON response."""
    if "predictions" not in data:
        raise RuntimeError(f"CO-OPS response carries no predictions: {data.get('error', data)}")
    events = []
    for prediction in data["predictions"]:
        t = datetime.strptime(prediction["t"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
        if not start <= t <= end:
            continue
        events.append(
            {
                "kind": "HW" if prediction["type"] == "H" else "LW",
                "time": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "height_m": round(float(prediction["v"]), 2),
            }
        )
    return events


def _fetch_port_coops_events(port: dict, start: datetime, end: datetime) -> list[dict]:
    """Live US path: official NOAA CO-OPS HW/LW predictions for one station."""
    import requests

    response = requests.get(
        COOPS_URL,
        params={
            "product": "predictions",
            "interval": "hilo",
            "datum": "MLLW",
            "units": "metric",
            "time_zone": "gmt",
            "station": port["coops_station"],
            "begin_date": start.strftime("%Y%m%d"),
            "end_date": end.strftime("%Y%m%d"),
            "format": "json",
        },
        timeout=60,
    )
    response.raise_for_status()
    return _coops_events_from_json(response.json(), start, end)


def _qld_events_from_csv(
    csv_text: str, start: datetime, end: datetime, utc_offset_hours: float
) -> list[dict]:
    """Schema events from an MSQ predicted high/low CSV (Date;Time local, Ind ±1)."""
    import csv as csv_module
    import io

    offset = timedelta(hours=utc_offset_hours)
    events = []
    for row in csv_module.DictReader(io.StringIO(csv_text)):
        local = datetime.strptime(f"{row['Date']} {row['Time']}", "%d/%m/%Y %H:%M")
        t = local.replace(tzinfo=timezone.utc) - offset
        if not start <= t <= end:
            continue
        events.append(
            {
                "kind": "HW" if row["Ind"].strip() == "1" else "LW",
                "time": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "height_m": round(float(row["Reading"]), 2),
            }
        )
    return events


def _fetch_port_qld_events(
    port: dict, start: datetime, end: datetime, live_source: dict
) -> list[dict]:
    """Live AU path: official MSQ high/low predictions from the QLD open-data portal."""
    import requests

    base_url = live_source.get("base_url", "https://www.data.qld.gov.au").rstrip("/")
    offset_hours = float(live_source.get("utc_offset_hours", 10))
    headers = {"User-Agent": "passage-deepregatta (davivasconcellos@gmail.com)"}

    package = requests.get(
        f"{base_url}/api/3/action/package_show",
        params={"id": port["qld_package"]},
        headers=headers,
        timeout=60,
    )
    package.raise_for_status()
    resources = package.json()["result"]["resources"]

    # the window's local dates decide which yearly CSVs are needed
    offset = timedelta(hours=offset_hours)
    years = sorted({(start + offset).year, (end + offset).year})
    events: list[dict] = []
    for year in years:
        resource = next(
            (
                r
                for r in resources
                if r.get("format", "").upper() == "CSV"
                and r.get("name", "").strip().startswith(str(year))
            ),
            None,
        )
        if resource is None:
            raise RuntimeError(f"no {year} predictions published for {port['qld_package']}")
        dump = requests.get(
            f"{base_url}/datastore/dump/{resource['id']}", headers=headers, timeout=60
        )
        dump.raise_for_status()
        events.extend(_qld_events_from_csv(dump.text, start, end, offset_hours))
    return events


def _live_doc(
    start: datetime, end: datetime, route_ports: dict[str, dict], live_source: dict
) -> dict:
    if live_source["kind"] == "noaa_coops":
        fetch_events = lambda port_id, port: _fetch_port_coops_events(port, start, end)  # noqa: E731
        note = (
            "HW/LW from NOAA CO-OPS official harmonic predictions "
            "(api.tidesandcurrents.noaa.gov, per-port station ids). Heights in "
            "metres above MLLW (US chart datum)."
        )
    elif live_source["kind"] == "qld_msq":
        fetch_events = lambda port_id, port: _fetch_port_qld_events(  # noqa: E731
            port, start, end, live_source
        )
        note = (
            "HW/LW from Maritime Safety Queensland official predictions "
            "(data.qld.gov.au open data, per-port gauge datasets). Heights in "
            "metres above LAT (QLD chart datum); times converted from AEST (UTC+10)."
        )
    else:
        dataset_id = live_source.get("dataset", CMEMS_SSH_DATASET)
        fetch_events = lambda port_id, port: _fetch_port_ssh_events(  # noqa: E731
            port_id, port, start, end, dataset_id
        )
        note = (
            f"HW/LW extracted from CMEMS model sea-surface height "
            f"({dataset_id}) at the nearest wet cell to each reference "
            "port. Heights = model SSH + port mean level above chart datum "
            "(approximate datum transfer); use for gate timing, not clearances."
        )
    ports = []
    for port_id, port in route_ports.items():
        ports.append(
            {
                "port_id": port_id,
                "name": port["name"],
                "lat": port["lat"],
                "lon": port["lon"],
                "events": fetch_events(port_id, port),
            }
        )
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {"mode": "live", "note": note},
        "ports": ports,
    }


def _synthetic_doc(
    start: datetime,
    end: datetime,
    route_ports: dict[str, dict],
    degraded_reason: str | None = None,
) -> dict:
    note = (
        "SYNTHETIC harmonic constituents — plausible regional character, not "
        "surveyed values. Never use for a real passage. Real source "
        "(SHOM/UKHO/FES) is a data swap behind the same contract."
    )
    if degraded_reason:
        note = f"live CMEMS fetch failed ({degraded_reason}); degraded to synthetic. " + note
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "mode": "synthetic",
            "constituents": list(OMEGA.keys()),
            "note": note,
        },
        "ports": [
            {
                "port_id": port_id,
                "name": port["name"],
                "lat": port["lat"],
                "lon": port["lon"],
                "events": hw_lw_events(port_id, start, end, ports=route_ports),
            }
            for port_id, port in route_ports.items()
        ],
    }


def prepare_tides(
    start_iso: str | None = None, hours: int = 96, route_id: str | None = None
) -> Path:
    from jsonschema import Draft202012Validator

    start = parse_iso_utc(start_iso) if start_iso else datetime.now(timezone.utc)
    end = start + timedelta(hours=hours)
    route_ports = tide_ports(route_id)

    if provider_mode("tides") is Mode.LIVE:
        try:
            doc = _live_doc(start, end, route_ports, tides_live_source(route_id))
        except Exception as error:  # feed failure must degrade, not crash
            logger.warning("live tides fetch failed, degrading to synthetic: %s", error)
            doc = _synthetic_doc(start, end, route_ports, degraded_reason=str(error))
    else:
        doc = _synthetic_doc(start, end, route_ports)

    schema = json.loads((contracts_dir() / "tides.schema.json").read_text())
    Draft202012Validator(schema).validate(doc)

    out_dir = processed_dir("tides")
    out = out_dir / f"{tides_artifact_name(route_id)}.json"
    out.write_text(json.dumps(doc, indent=1))
    # Advertise only registered artifacts actually present in this warehouse.
    # Rebuilding also removes mappings for deleted files without inventing data.
    routes = {
        registered_id: f"{entry['tides']['artifact_name']}.json"
        for registered_id, entry in load_route_sources()["routes"].items()
        if (out_dir / f"{entry['tides']['artifact_name']}.json").is_file()
    }
    (out_dir / "index.json").write_text(
        json.dumps({"schema_version": 1, "routes": routes}, indent=1) + "\n"
    )
    return out
