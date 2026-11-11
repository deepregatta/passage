# ports.json: provenance

`ports.json` is the list of ports that names the start and finish a sailor taps on the Plan
map (`viewer/src/lib/ports.js`). It holds `[name, latitude, longitude]` for 3,807 ports,
sorted by latitude, coordinates rounded to 3 decimals (about 60 m). Nothing else of the
source is kept.

## Source

- **Data:** the US National Geospatial-Intelligence Agency (NGA) World Port Index
  (Publication 150).
- **Obtained on 11 November 2026** from the Esri Deutschland ArcGIS Online service, because
  msi.nga.mil (NGA's own download page) was unavailable that day. The data was not taken
  from NGA directly. **A refresh straight from NGA is a planned follow-up.**
- **Service:** `https://services2.arcgis.com/jUpNdisbWqRpMo35/ArcGIS/rest/services/WPI_Ports2017/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson`
  (ArcGIS item `b04b76b94059436e93757c301c10026c`, title "World Port Index", owner
  `esri_DE_content`). The service is named `WPI_Ports2017`; its description reads
  "NGA's World Port Index. Stand: October 2026". Both are recorded because they disagree: the
  name is probably historical (the item was created in April 2018 and last modified on
  14 October 2026).
- **File downloaded:** `WPI_Ports2017.geojson`, 14,295,686 bytes, 3,807 features
  (3,805 distinct World Port Index numbers: numbers 400 and 46135 each appear twice).
- **Licence:** public domain. The item's licence text says "All the ports data has been
  released into Public Domain" and links Creative Commons Public Domain Mark 1.0; it adds that
  the service "is based on a Publication by NGA". NGA's disclaimer applies: the reproduction
  is not approved, authorized or endorsed by the US Secretary of Defense, the Director of
  National Intelligence, the Director of NGA or any other element of the US Government, and
  they accept no liability for its accuracy. Public domain needs no attribution; Passage
  does not claim NGA endorsement.

## Checks made before it was committed

- Cross-check against the UN OCHA copy on HDX (CC0), `world_port_index.zip` (603,601 bytes;
  an older edition, 3,669 ports). Of 3,595 ports present in both by World Port Index
  number, 3,517 (97.8 %) agree within 1 nm, 68 within 5 nm and 10 differ by more than 5 nm.
  The large differences are edition changes or errors in the older copy (the two
  Gloucesters, Lanshan, renumbered Soendre Stroemfjord/Lekki), not disagreement about
  well-known ports. The Esri copy was used.
- Coordinates are all in range, and the service geometry agrees with its Latitude/Longitude
  fields. Cherbourg, Plymouth, Newport (Rhode Island), New York, Palma de Mallorca,
  Barcelona, Brisbane and Gladstone are each within 1.6 nm of their known position.

## Names

Names are as the source has them (ASCII, as the World Port Index writes them, so they carry
no accents) with these tidy-ups, all in `scripts/build-ports.py`: repeated spaces collapsed,
`D' Olonne` joined to `D'Olonne`, small joining words lower-cased inside a name
(`Palma De Mallorca` becomes `Palma de Mallorca`), and "Rade de" / "Rade d'" (roadstead of)
dropped, which changes only `Rade De Cherbourg` to `Cherbourg` and `Rade De Brest` to `Brest`.
Names are proper nouns and are shown the same in English and French.

## Regenerate

1. Download the GeoJSON from the service URL above into an empty scratch directory outside
   the repository. Do not commit it.
2. From another directory: `python3 -I scripts/build-ports.py /path/to/WPI_Ports2017.geojson`
   (the script is stdlib only, validates the input and fails if a required port is missing).
3. Update this note (date, counts, sizes) and `docs/port-names.md`, then run the viewer tests.

The planned refresh from NGA (https://msi.nga.mil/Publications/WPI, CSV) needs the script
to read that file's columns instead; keep the output format.
