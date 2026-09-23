/**
 * Test-only GRIB2 reader for the subset the exporter writes (template 3.0,
 * 4.0, 5.0 simple packing, optional bitmap). Independent of the encoder so
 * engine tests can round-trip files; ecCodes is the external check
 * (analysis/tests/test_grib_export_contract.py).
 */

export interface ParsedGribMessage {
  offset: number;
  length: number;
  discipline: number;
  sections: Array<{ number: number; offset: number; length: number }>;
  centre: number;
  subCentre: number;
  refTime: string;
  grid: {
    points: number;
    shape: number;
    ni: number;
    nj: number;
    la1: number;
    lo1: number;
    la2: number;
    lo2: number;
    di: number;
    dj: number;
    flags: number;
    scanningMode: number;
  };
  product: {
    category: number;
    number: number;
    generatingProcess: number;
    unit: number;
    forecastTime: number;
    levelType: number;
    levelScale: number;
    levelValue: number;
  };
  packing: { count: number; reference: number; binaryScale: number; decimalScale: number; nbits: number };
  bitmapIndicator: number;
  /** decoded values in scan order, NaN = missing */
  values: Float64Array;
}

const signMagnitude32 = (v: number) => (v & 0x80000000 ? -(v & 0x7fffffff) : v);
const signMagnitude16 = (v: number) => (v & 0x8000 ? -(v & 0x7fff) : v);

export function readGrib2(bytes: Uint8Array): ParsedGribMessage[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const messages: ParsedGribMessage[] = [];
  let start = 0;
  while (start < bytes.byteLength) {
    const magic = String.fromCharCode(...bytes.subarray(start, start + 4));
    if (magic !== 'GRIB') throw new Error(`no GRIB message at ${start}`);
    if (view.getUint8(start + 7) !== 2) throw new Error('not GRIB edition 2');
    const length = view.getUint32(start + 8) * 2 ** 32 + view.getUint32(start + 12);
    const discipline = view.getUint8(start + 6);
    const sections: ParsedGribMessage['sections'] = [];
    let at = start + 16;
    const body: Record<number, number> = {};
    while (at < start + length - 4) {
      const len = view.getUint32(at);
      const number = view.getUint8(at + 4);
      sections.push({ number, offset: at - start, length: len });
      body[number] = at;
      at += len;
    }
    if (String.fromCharCode(...bytes.subarray(at, at + 4)) !== '7777' || at + 4 !== start + length) {
      throw new Error(`message at ${start} does not end with 7777 at its stated length`);
    }
    const s1 = body[1]!;
    const s3 = body[3]!;
    const s4 = body[4]!;
    const s5 = body[5]!;
    const s6 = body[6]!;
    const s7 = body[7]!;
    const pad = (v: number) => String(v).padStart(2, '0');
    const refTime = `${view.getUint16(s1 + 12)}-${pad(view.getUint8(s1 + 14))}-${pad(view.getUint8(s1 + 15))}` +
      `T${pad(view.getUint8(s1 + 16))}:${pad(view.getUint8(s1 + 17))}:${pad(view.getUint8(s1 + 18))}Z`;
    const grid = {
      points: view.getUint32(s3 + 6),
      shape: view.getUint8(s3 + 14),
      ni: view.getUint32(s3 + 30),
      nj: view.getUint32(s3 + 34),
      la1: signMagnitude32(view.getUint32(s3 + 46)),
      lo1: signMagnitude32(view.getUint32(s3 + 50)),
      flags: view.getUint8(s3 + 54),
      la2: signMagnitude32(view.getUint32(s3 + 55)),
      lo2: signMagnitude32(view.getUint32(s3 + 59)),
      di: view.getUint32(s3 + 63),
      dj: view.getUint32(s3 + 67),
      scanningMode: view.getUint8(s3 + 71),
    };
    const product = {
      category: view.getUint8(s4 + 9),
      number: view.getUint8(s4 + 10),
      generatingProcess: view.getUint8(s4 + 13),
      unit: view.getUint8(s4 + 17),
      forecastTime: view.getUint32(s4 + 18),
      levelType: view.getUint8(s4 + 22),
      levelScale: view.getUint8(s4 + 23),
      levelValue: view.getUint32(s4 + 24),
    };
    const packing = {
      count: view.getUint32(s5 + 5),
      reference: view.getFloat32(s5 + 11),
      binaryScale: signMagnitude16(view.getUint16(s5 + 15)),
      decimalScale: signMagnitude16(view.getUint16(s5 + 17)),
      nbits: view.getUint8(s5 + 19),
    };
    const bitmapIndicator = view.getUint8(s6 + 5);
    const values = new Float64Array(grid.points).fill(NaN);
    let bit = 0;
    const readBits = (n: number) => {
      let out = 0;
      for (let b = 0; b < n; b++, bit++) {
        out = out * 2 + ((bytes[s7 + 5 + (bit >> 3)]! >> (7 - (bit & 7))) & 1);
      }
      return out;
    };
    let decoded = 0;
    for (let k = 0; k < grid.points; k++) {
      const presentBit = bitmapIndicator === 255 ? 1 : (bytes[s6 + 6 + (k >> 3)]! >> (7 - (k & 7))) & 1;
      if (!presentBit) continue;
      const raw = packing.reference + readBits(packing.nbits) * 2 ** packing.binaryScale;
      // Divide for D ≥ 0 and multiply otherwise, so decimal results stay exact doubles.
      values[k] = packing.decimalScale >= 0 ? raw / 10 ** packing.decimalScale : raw * 10 ** -packing.decimalScale;
      decoded += 1;
    }
    if (decoded !== packing.count) throw new Error(`bitmap has ${decoded} points, section 5 says ${packing.count}`);
    messages.push({
      offset: start, length, discipline, sections,
      centre: view.getUint16(s1 + 5),
      subCentre: view.getUint16(s1 + 7),
      refTime, grid, product, packing, bitmapIndicator, values,
    });
    start += length;
  }
  return messages;
}
