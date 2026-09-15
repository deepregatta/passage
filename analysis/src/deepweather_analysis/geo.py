"""Scalar geography shared by observation matching and synoptic evaluation."""

import math

EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km, retaining the observation matcher's precision."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2.0) ** 2
    return 2.0 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def separation_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Local degree separation with longitude scaled by cos(mean latitude).

    This preserves the synoptic tracking/corpus gate, including raw longitude
    differences. It is an approximation, distinct from great-circle distance.
    """
    dlat = lat1 - lat2
    coslat = math.cos(math.radians(0.5 * (lat1 + lat2)))
    dlon = (lon1 - lon2) * coslat
    return math.hypot(dlat, dlon)
