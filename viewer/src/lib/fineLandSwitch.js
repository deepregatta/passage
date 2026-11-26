/**
 * The fine routing index (TLI1, 1/480°: land, drying areas and a 200 m buffer) from
 * 10°W to 10°E and 40°N to 60°N: forecast-tiles' published nweu-20260825T07Z, served
 * from this site as a pinned copy (contracts/shared-contracts.lock.json,
 * docs/shared-contracts.md).
 */
export const FINE_LAND_INDEX = '/data/land/nweu-20260825T07Z';
/**
 * Whether computed routes read the fine index where it has tiles, and the About page
 * credits its sources. Off: every route reads the 0.05° outline alone, as before.
 * Turning it on changes computed routes on the public site, so it needs the owner's
 * approval.
 */
export const FINE_LAND_ENABLED = false;
