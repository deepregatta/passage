/**
 * The credit text an exported GRIB2 message carries in its Section 2 (Local
 * Use Section) when the request sets `creditSection`, so a file passed on
 * keeps its data credit, licence and modification statement. Off by default
 * until sailing readers have opened such files (docs/grib-export.md →
 * Credits inside the file).
 *
 * Layout of the section content (after the 5-byte length and number header):
 * two zero bytes, then UTF-8 text, one line per item, each ending in "\n".
 * ecCodes reads the first two bytes as the originating centre's local
 * definition number: 0 is "Empty local section" in ECMWF's (98) and
 * Météo-France's (85) tables and makes it skip the rest as padding for every
 * centre. Text in those two bytes stops ecCodes decoding centre 98 and 85
 * messages at all, so the encoder refuses a payload that does not start with 0.
 */

import { GRIB_EXPORT_NOTICE, type GribDatasetSpec } from './gribDatasets.js';

/** Section 2 header: 4-byte length and the section number. */
export const GRIB_SECTION2_HEADER_BYTES = 5;

/** First line: says whose text this is, and how it is encoded. */
export const GRIB_CREDIT_HEADER =
  'Passage by DeepRegatta: data credit and licence. UTF-8 text added by Passage, not by the originating centre.';

export const GRIB_CREDIT_PRODUCED_BY =
  'This GRIB message was produced by Passage by DeepRegatta from that data and modified; ' +
  'it is not an official product of the data provider.';

/** The lines written into Section 2 for a dataset, in order. */
export function gribCreditLines(spec: Pick<GribDatasetSpec, 'attribution'>): string[] {
  return [GRIB_CREDIT_HEADER, `Data sources: ${spec.attribution}`, GRIB_CREDIT_PRODUCED_BY, GRIB_EXPORT_NOTICE];
}

export function gribCreditText(spec: Pick<GribDatasetSpec, 'attribution'>): string {
  return gribCreditLines(spec).map((line) => `${line}\n`).join('');
}

const payloads = new Map<string, Uint8Array>();

/**
 * Section 2 content for a dataset: local section number 0, then the credit
 * text in UTF-8. Same dataset, same bytes. Callers must not modify it.
 */
export function gribCreditPayload(spec: Pick<GribDatasetSpec, 'attribution'>): Uint8Array {
  let payload = payloads.get(spec.attribution);
  if (!payload) {
    const text = new TextEncoder().encode(gribCreditText(spec));
    payload = new Uint8Array(2 + text.byteLength);
    payload.set(text, 2);
    payloads.set(spec.attribution, payload);
  }
  return payload;
}

/** Bytes Section 2 adds to each message of the dataset's file. */
export function gribCreditSectionBytes(spec: Pick<GribDatasetSpec, 'attribution'>): number {
  return GRIB_SECTION2_HEADER_BYTES + gribCreditPayload(spec).byteLength;
}
