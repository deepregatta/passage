/**
 * Current model products, keyed by the dataset product a recorded model id
 * names (never by its time-step suffix such as `PT1H`: the factory may thin an
 * hourly-named dataset, so the step is read from the grid's own time axis,
 * gridTimeStepHours, and recorded with each check).
 *
 * `tide` is what the product is known to do: true includes tide, false has
 * none, null not recorded here. The facts are the GRIB page's dataset notes
 * (export/gribDatasets.ts): Copernicus IBI is "regional model currents
 * including tide"; Copernicus global (GLO12) "Tides are not resolved". No
 * prepared artifact records it (contracts/region-grid.schema.json), so this
 * table is the one place that decides it; the viewer names the same products
 * from it (viewer/src/lib/sourceNames.js).
 *
 * Ids are the tile models forecast-tiles publishes (`currents` carries
 * cmems_glo12, `currents-ibi` cmems_ibi), the factory's prepared Copernicus
 * dataset ids (REGION_PRIORITY IBI, NWS, MED, BAL, GLO) and RTOFS, which older
 * pipeline notes name as a historical fallback.
 */

export type CurrentProductId = 'glo12' | 'ibi' | 'nws' | 'med' | 'bal' | 'rtofs';

export const CURRENT_PRODUCTS: ReadonlyArray<{ id: CurrentProductId; pattern: RegExp; tide: boolean | null }> = [
  { id: 'glo12', pattern: /^(cmems_glo12$|cmems_mod_glo_phy)/i, tide: false },
  { id: 'ibi', pattern: /^(cmems_ibi$|cmems_mod_ibi_phy)/i, tide: true },
  { id: 'nws', pattern: /^cmems_mod_nws_phy/i, tide: null },
  { id: 'med', pattern: /^cmems_mod_med_phy/i, tide: null },
  { id: 'bal', pattern: /^cmems_mod_bal_phy/i, tide: null },
  { id: 'rtofs', pattern: /^rtofs/i, tide: null },
];

/**
 * The product a model id names, or null for an id that identifies none
 * ("cmems", "currents", a test label, nothing).
 */
export function currentProduct(id: unknown): { id: CurrentProductId; tide: boolean | null } | null {
  const text = typeof id === 'string' ? id.trim() : '';
  const product = text ? CURRENT_PRODUCTS.find(({ pattern }) => pattern.test(text)) : undefined;
  return product ? { id: product.id, tide: product.tide } : null;
}

/**
 * The model id inside a current grid built from tiles, whose dataset id (and
 * so its recorded `model`) reads "<model> tiles (<run>)" (forecast/tileStore.ts);
 * null for any other id.
 */
export const tileModelId = (datasetId: unknown): string | null =>
  /^(\S+) tiles \(/.exec(typeof datasetId === 'string' ? datasetId : '')?.[1] ?? null;

/** Whether a check's record of its current grid says the grid came from tiles. */
export function currentRecordFromTiles(record: Record<string, unknown>): boolean {
  return record.current_source === 'tiles' || record.source === 'tiles' || tileModelId(record.model) !== null;
}

/** The product of the current grid a check's input record names; a tile grid's model is read from its tile id. */
export function currentRecordProduct(record: Record<string, unknown> | null | undefined): ReturnType<typeof currentProduct> {
  if (!record) return null;
  return currentProduct(currentRecordFromTiles(record) ? tileModelId(record.model) : record.model);
}
