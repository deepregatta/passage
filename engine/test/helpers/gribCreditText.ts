/**
 * The Section 2 text an exported GRIB message must carry, written out here
 * independently of src/export/gribCredit.ts so tests derive sizes and content
 * from the specification (docs/grib-export.md → Credits inside the file).
 */

const HEADER = 'Passage by DeepRegatta: data credit and licence. UTF-8 text added by Passage, not by the originating centre.';
const PRODUCED = 'This GRIB message was produced by Passage by DeepRegatta from that data and modified; it is not an official product of the data provider.';
const NOTICE = 'Forecast data for planning, not for navigation. Check official forecasts and warnings.';

export const expectedCreditText = (credit: string): string => `${HEADER}\nData sources: ${credit}\n${PRODUCED}\n${NOTICE}\n`;

/** Bytes Section 2 adds per message: 5-byte header, local section number 0 (2 bytes), UTF-8 text. */
export const expectedCreditSectionBytes = (credit: string): number =>
  5 + 2 + new TextEncoder().encode(expectedCreditText(credit)).byteLength;
