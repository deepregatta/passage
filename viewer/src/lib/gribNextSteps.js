// Vendored from coachregatta public /data/{id}/meta.json, 2026-10-04 (course data only).
// Static course coordinates from OSCAR's public /data/{id}/meta.json, checked
// against its live /data/races.json on 2026-10-04. No runtime cross-repo reads.
import races from './gribReplayRaces.json';
import { validGribArea } from './gribExport.js';

// Clip a course segment to the chosen box. Course bounding boxes alone would
// recommend ARC for places far away from its transatlantic course.
function crossesArea([lat, lon], [endLat, endLon], area) {
  let first = 0;
  let last = 1;
  for (const [start, end, min, max] of [
    [lat, endLat, area.minLat, area.maxLat],
    [lon, endLon, area.minLon, area.maxLon],
  ]) {
    const delta = end - start;
    if (delta === 0) {
      if (start < min || start > max) return false;
    } else {
      const a = (min - start) / delta;
      const b = (max - start) / delta;
      first = Math.max(first, Math.min(a, b));
      last = Math.min(last, Math.max(a, b));
      if (first > last) return false;
    }
  }
  return true;
}

export function gribReplayRaces(area) {
  if (!validGribArea(area)) return [];
  return races.filter((race) => race.course.some((point, i) =>
    i > 0 && crossesArea(race.course[i - 1], point, area)));
}

export function gribReplayUrl(race, language) {
  return `https://oscar.deepregatta.com/?race=${race.id}&tab=map&lang=${language === 'fr' ? 'fr' : 'en'}`;
}
