# Port names for tapped start and finish points

A start or finish tapped (or a drawn waypoint dragged) on the Plan map is given the name of
the nearest port of a bundled list when one lies within 5 nautical miles. The passage is then
named "Start → Finish" (for example "Cherbourg → Plymouth") by the existing default-name rule
in `viewer/src/pages/planner/passageName.js`, until the sailor types a name.

## Privacy

The lookup runs entirely in the browser over a static file of the Passage site. No position is
sent anywhere to find a name, there is no geocoder and the Content-Security-Policy is
unchanged. The [privacy page](../viewer/src/privacyContent.js) says so.

## Where things live

| What | Where |
|---|---|
| Data: 3,807 `[name, lat, lon]` entries, 109,382 bytes raw, about 43 KB gzip | `viewer/src/data/ports.json` |
| Provenance, licence, checks, regeneration | `viewer/src/data/PROVENANCE.md` |
| Build script (stdlib Python, validates the input) | `scripts/build-ports.py` |
| Lookup: `nearestPort(ports, lat, lon, maxNm = 5)`, pure | `viewer/src/lib/portLookup.js` |
| Lazy loader: `loadPorts()` (a dynamic import, its own chunk), `portNameAt()` | `viewer/src/lib/ports.js` |
| Behaviour on tap and drag | `viewer/src/pages/planner/usePlannerController.jsx`, `passageName.js` (`placedPoint`) |

The file is a dynamic import, so first paint does not load it; the planner starts the load when
it opens. If it cannot be loaded, points stay unnamed and the passage keeps its generic name.

## Source and licence

NGA World Port Index (Publication 150), public domain. It was obtained on 11 November 2026 from
the Esri Deutschland ArcGIS service `WPI_Ports2017` (item `b04b76b94059436e93757c301c10026c`,
"Stand: October 2026"), not from NGA, because msi.nga.mil was unavailable. It was cross-checked
against the UN OCHA copy on HDX (CC0): 97.8 % of the ports present in both agree within 1 nm.
Passage does not claim NGA endorsement. **A refresh directly from NGA is a planned follow-up.**
The full note, with the licence wording, is `viewer/src/data/PROVENANCE.md`.

## Naming rules

- Port names are proper nouns: shown exactly as in the list in English and French, and kept out
  of the French localiser. The list's names are the World Port Index's, without accents.
- A tapped or dragged point takes the nearest port within 5 nm, or none. A point moved out of
  range loses a name a port gave it.
- A name that came from an imported GPX file is never replaced, and a name the sailor typed for
  the passage is never overwritten (`nameAuto` becomes false).
- Names are set when the point is placed. A draft restored from storage is never named
  retroactively. If the list arrives after a tap, that point is named once it does, but only
  while it is unchanged and no route has been computed or checked from it, so a late file cannot
  change a route that already has results. The name is a display label: it is not part of the
  routing inputs, the passage ID or any saved check, which are never altered.
  (`route_revision` hashes the route including its name at the moment of a check; see
  [saved identities](saved-identities.md).)

## Threshold

5 nautical miles, nearest port wins. It is about a harbour approach: a tap in a channel or
roadstead counts, while a point in open water between two harbours names neither. The World
Port Index positions are one point per port, often at the harbour mouth or town centre, so a
tighter radius would miss reasonable taps. Change `PORT_RADIUS_NM` in `portLookup.js` to adjust.
