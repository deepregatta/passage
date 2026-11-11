#!/usr/bin/env python3
"""Build viewer/src/data/ports.json from a download of the NGA World Port Index.

Usage (see viewer/src/data/PROVENANCE.md for where the input comes from):

    python3 -I scripts/build-ports.py INPUT.geojson [OUTPUT.json]

INPUT is the GeoJSON the Esri Deutschland service returns (fields
Main_Port_Name, Latitude, Longitude, World_Port_Index_Number). It is treated as
untrusted: it is only parsed as JSON, every value is type- and range-checked,
and nothing in it is executed or fetched. Run it with `-I` and from outside the
directory the download sits in.

OUTPUT (default viewer/src/data/ports.json) is {"ports": [[name, lat, lon], ...]},
sorted by latitude then longitude, coordinates rounded to 3 decimals
(about 60 m), names as the source has them apart from the tidy-ups below.
Nothing but the name and the position of each port is kept.
"""
import json
import math
import re
import sys
from pathlib import Path

DEFAULT_OUT = Path(__file__).resolve().parent.parent / 'viewer' / 'src' / 'data' / 'ports.json'

# Lower-case words inside a name that the source capitalises ("Palma De Mallorca").
PARTICLES = {'de', 'del', 'della', 'di', 'da', 'do', 'dos', 'das', 'du', 'des', 'la', 'le', 'les', 'aux', 'of', 'y'}

# What the sailor expects to read for ports that must be found by these names.
REQUIRED = {  # name -> (lat, lon), within 3 nm
    'Cherbourg': (49.65, -1.62),
    'Plymouth': (50.37, -4.14),
    'Newport': (41.49, -71.33),
    'New York City': (40.70, -74.02),
    'Palma de Mallorca': (39.56, 2.64),
    'Barcelona': (41.35, 2.17),
    'Brisbane': (-27.38, 153.17),
    'Gladstone': (-23.83, 151.26),
}


def tidy(name):
    name = ' '.join(name.split())            # "Ras  Tannurah" -> "Ras Tannurah"
    name = re.sub(r"(?<=[A-Za-z])' (?=[A-Za-z])", "'", name)  # "Sables D' Olonne" -> "Sables D'Olonne"
    # "Rade De Cherbourg" is the roadstead of a town: the place is the town.
    match = re.match(r"^Rade (?:De |D')(.+)$", name)
    if match:
        name = match.group(1)
    words = name.split(' ')
    words = [w.lower() if i > 0 and w.lower() in PARTICLES else w for i, w in enumerate(words)]
    return ' '.join(words)


def distance_nm(lat_a, lon_a, lat_b, lon_b):
    r = math.pi / 180
    h = math.sin((lat_b - lat_a) * r / 2) ** 2 + math.cos(lat_a * r) * math.cos(lat_b * r) * math.sin((lon_b - lon_a) * r / 2) ** 2
    return 2 * 3440.065 * math.asin(min(1.0, math.sqrt(h)))


def build(source):
    features = source['features']
    ports, seen = [], set()
    for feature in features:
        props = feature['properties']
        name, lat, lon = props['Main_Port_Name'], props['Latitude'], props['Longitude']
        if not isinstance(name, str) or not name.strip():
            continue
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (lat, lon)):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError(f'coordinates out of range: {name!r} {lat} {lon}')
        entry = (tidy(name), round(lat, 3), round(lon, 3))
        if entry in seen:
            continue
        seen.add(entry)
        ports.append(entry)
    ports.sort(key=lambda p: (p[1], p[2], p[0]))
    if len(ports) < 3500:
        raise ValueError(f'only {len(ports)} ports: not the World Port Index')
    for name, (lat, lon) in REQUIRED.items():
        near = [p for p in ports if p[0] == name and distance_nm(lat, lon, p[1], p[2]) <= 3]
        if not near:
            raise ValueError(f'{name} is missing or misplaced')
    return ports


def main(argv):
    if len(argv) not in (2, 3):
        print(__doc__)
        return 2
    with open(argv[1], encoding='utf-8') as handle:
        ports = build(json.load(handle))
    out = Path(argv[2]) if len(argv) == 3 else DEFAULT_OUT
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps({'ports': [list(p) for p in ports]}, ensure_ascii=False, separators=(',', ':')) + '\n'
    out.write_text(text, encoding='utf-8')
    print(f'{len(ports)} ports written to {out} ({len(text.encode("utf-8"))} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
