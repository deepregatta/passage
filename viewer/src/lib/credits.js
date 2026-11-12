/**
 * Credit text a data provider prescribes, shown as written in every language
 * (the French pages mark it data-i18n-owned: see OWNED in passages.js). Wording
 * comes from the recorded terms only: forecast-tiles DATA-LICENSES.md, section
 * "Terms read on 12 November 2026", and the data-source registers.
 * Passage's own words around these (labels, the modification clause) stay in the
 * French catalogue (i18n.js). Not shown, because their wording is not recorded:
 * ECMWF's disclaimer and the full ERA5 citation.
 */

const CC_BY_4 = 'https://creativecommons.org/licenses/by/4.0/';

/** The map's attribution while the ECMWF wind arrows are drawn: owned source and licence link, then Passage's "(modified)". */
export const ECMWF_MAP_CREDIT = `<span data-i18n-owned="message">ECMWF open data, <a href="${CC_BY_4}" target="_blank" rel="noopener noreferrer">CC BY 4.0</a></span> (modified)`;

/** Copernicus Marine's credit for derived works (licence summary in the forecast-tiles register). */
export const COPERNICUS_CREDIT = 'Generated using E.U. Copernicus Marine Service Information';

/**
 * The credit line under the current block: the Copernicus sentence, with the product's DOI where
 * one is recorded (the forecast-tiles register: GLO12 and IBI). Null for a source that is not
 * Copernicus or whose family is not recorded.
 * @param {{ copernicus: boolean, doi: string | null } | null} family from currentModelFamily
 * @returns {string | null}
 */
export function currentCreditLine(family) {
  if (!family?.copernicus) return null;
  return family.doi ? `${COPERNICUS_CREDIT}; doi:${family.doi}` : COPERNICUS_CREDIT;
}

/**
 * ERA5's dataset credit: the dataset name, its DOI (read on the Climate Data Store dataset page,
 * 12 November 2026) and the licence. The full citation text was not readable there, so none is invented.
 */
export const ERA5_CREDIT = `ERA5 reanalysis (Copernicus Climate Data Store), doi:10.24381/cds.adbb2d47; CC BY 4.0 (${CC_BY_4})`;
