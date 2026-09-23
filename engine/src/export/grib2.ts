/**
 * Minimal GRIB2 encoder for route-area forecast exports (docs/grib-export.md):
 * one field per message on a regular lat/lon grid (template 3.0), a forecast
 * at a horizontal level (4.0) and simple packing (5.0) with a section-6 bitmap
 * when any point is missing. Integers are big-endian; latitudes, signed
 * longitudes and the section-5 scale factors are sign-magnitude, not two's
 * complement. ecCodes decodes the golden fixtures in the analysis contract
 * test, so any byte change here forces fixture regeneration.
 */

import { parseUtc } from '../eta.js';

export type LonConvention = '0-360' | 'signed';

/**
 * Regular export lattice: global index k ↔ k·10/n degrees, so tiles and
 * datasets at the same resolution share points without float drift. Longitude
 * indices are signed (−180..180); only the encoded corners wrap to 0–360.
 */
export interface GribLattice {
  /** lattice points per 10° (40, 120 or 360) */
  n: number;
  /** grid increment in integer micro-degrees: round(1e7 / n) */
  stepMicro: number;
  kS: number;
  kN: number;
  kW: number;
  kE: number;
  ni: number;
  nj: number;
}

export interface GribLevel {
  /** Code table 4.5 type of first fixed surface */
  type: number;
  /** scaled value with scale factor 0 */
  value: number;
}

export interface Grib2Field {
  /** 0 meteorological, 10 oceanographic */
  discipline: number;
  centre: number;
  subCentre?: number;
  generatingProcess: number;
  /** the layer's model cycle, written as the section-1 reference time */
  cycle: string;
  /** whole hours after the cycle */
  forecastHours: number;
  category: number;
  number: number;
  level: GribLevel;
  /** decimal scale factor D: values are written as round(v·10^D) / 10^D */
  decimalScale: number;
  lattice: GribLattice;
  lonConvention?: LonConvention;
  /** ni·nj values in output units, rows north→south, i (longitude) fastest; NaN = missing */
  values: ArrayLike<number>;
}

const SECTION_BYTES = { s0: 16, s1: 21, s3: 72, s4: 34, s5: 21, s8: 4 } as const;
const MICRO_360 = 360_000_000;
const MAX_PACKED = 2 ** 24;

/** The value a reader decodes for v at decimal scale D (never −0). */
export function gribRound(value: number, decimalScale: number): number {
  const s = 10 ** decimalScale;
  return Math.round(value * s) / s + 0;
}

/** Corner coordinates as written in section 3, in micro-degrees. */
export function latticeCornersMicro(
  lattice: GribLattice,
  lonConvention: LonConvention = '0-360',
): { la1: number; lo1: number; la2: number; lo2: number } {
  // Lattice longitudes are already signed (−180..180), so 'signed' writes them as is.
  const lon = (k: number) => {
    const micro = k * lattice.stepMicro;
    return lonConvention === 'signed' ? micro : mod(micro, MICRO_360);
  };
  return {
    la1: lattice.kN * lattice.stepMicro,
    lo1: lon(lattice.kW),
    la2: lattice.kS * lattice.stepMicro,
    lo2: lon(lattice.kE),
  };
}

/**
 * Encode one GRIB2 message, or null when every value is missing (callers
 * skip and count such messages rather than write an empty field).
 */
export function encodeGrib2Message(field: Grib2Field): Uint8Array | null {
  const { lattice } = field;
  const count = lattice.ni * lattice.nj;
  checkLattice(lattice);
  if (field.values.length !== count) {
    throw new Error(`GRIB field has ${field.values.length} values for a ${lattice.ni}×${lattice.nj} grid`);
  }
  checkUint('discipline', field.discipline, 1);
  checkUint('centre', field.centre, 2);
  checkUint('subCentre', field.subCentre ?? 0, 2);
  checkUint('generatingProcess', field.generatingProcess, 1);
  checkUint('category', field.category, 1);
  checkUint('number', field.number, 1);
  checkUint('level type', field.level.type, 1);
  checkUint('level value', field.level.value, 4);
  checkUint('forecastHours', field.forecastHours, 4);
  if (!Number.isInteger(field.decimalScale) || Math.abs(field.decimalScale) > 0x7fff) {
    throw new Error(`GRIB decimal scale out of range: ${field.decimalScale}`);
  }

  // Simple packing with E = 0: integers relative to their minimum.
  const s = 10 ** field.decimalScale;
  const ints = new Float64Array(count);
  let present = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < count; k++) {
    const v = field.values[k]!;
    if (Number.isNaN(v)) continue;
    if (!Number.isFinite(v)) throw new Error('GRIB field contains a non-finite value');
    const q = Math.round(v * s);
    ints[present++] = q;
    if (q < min) min = q;
    if (q > max) max = q;
  }
  if (present === 0) return null;
  if (Math.abs(min) >= MAX_PACKED) throw new Error(`GRIB reference value out of range: ${min}`);
  const range = max - min;
  if (range >= MAX_PACKED) throw new Error(`GRIB packed range out of range: ${range}`);
  const nbits = range === 0 ? 0 : Math.ceil(Math.log2(range + 1));
  // ecCodes and NCEP g2clib return R itself when nbits = 0 and ignore D, so a
  // constant field is written with D = 0 and R = the rounded value.
  const decimalScale = nbits === 0 ? 0 : field.decimalScale;
  const reference = nbits === 0 ? min / s : min;
  const bitmap = present < count;

  const s6 = 6 + (bitmap ? Math.ceil(count / 8) : 0);
  const s7 = 5 + Math.ceil((present * nbits) / 8);
  const total = SECTION_BYTES.s0 + SECTION_BYTES.s1 + SECTION_BYTES.s3 + SECTION_BYTES.s4 +
    SECTION_BYTES.s5 + s6 + s7 + SECTION_BYTES.s8;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const u8 = (v: number) => { view.setUint8(at, v); at += 1; };
  const u16 = (v: number) => { view.setUint16(at, v); at += 2; };
  const u32 = (v: number) => { view.setUint32(at, v); at += 4; };
  const s16 = (v: number) => { view.setUint16(at, v < 0 ? 0x8000 | -v : v); at += 2; };
  const s32 = (v: number) => { view.setUint32(at, v < 0 ? (0x80000000 | -v) >>> 0 : v); at += 4; };

  // Section 0: indicator
  out.set([0x47, 0x52, 0x49, 0x42], 0); // "GRIB"
  at = 6;
  u8(field.discipline);
  u8(2);
  u32(Math.floor(total / 2 ** 32));
  u32(total >>> 0);

  // Section 1: identification; reference time = the model cycle
  const ref = new Date(parseUtc(field.cycle));
  u32(SECTION_BYTES.s1);
  u8(1);
  u16(field.centre);
  u16(field.subCentre ?? 0);
  u8(2); // master tables version
  u8(0); // local tables version
  u8(1); // significance of reference time: start of forecast
  u16(ref.getUTCFullYear());
  u8(ref.getUTCMonth() + 1);
  u8(ref.getUTCDate());
  u8(ref.getUTCHours());
  u8(ref.getUTCMinutes());
  u8(ref.getUTCSeconds());
  u8(0); // production status: operational
  u8(1); // type of processed data: forecast

  // Section 3: grid definition, template 3.0 (regular lat/lon)
  const corners = latticeCornersMicro(lattice, field.lonConvention);
  u32(SECTION_BYTES.s3);
  u8(3);
  u8(0); // source of grid definition: template
  u32(count);
  u8(0); // no optional list of points
  u8(0);
  u16(0); // template 3.0
  u8(6); // shape of the Earth: sphere, radius 6,371,229 m
  for (let k = 0; k < 3; k++) {
    u8(0xff);
    u32(0xffffffff);
  }
  u32(lattice.ni);
  u32(lattice.nj);
  u32(0); // basic angle: micro-degrees
  u32(0xffffffff);
  s32(corners.la1);
  s32(corners.lo1);
  u8(0x30); // increments given; u/v relative to east/north
  s32(corners.la2);
  s32(corners.lo2);
  u32(lattice.stepMicro); // Di
  u32(lattice.stepMicro); // Dj
  u8(0x00); // scanning: +i west→east, −j north→south, rows consecutive

  // Section 4: product definition, template 4.0
  u32(SECTION_BYTES.s4);
  u8(4);
  u16(0); // no coordinate values
  u16(0); // template 4.0
  u8(field.category);
  u8(field.number);
  u8(2); // type of generating process: forecast
  u8(0); // background process
  u8(field.generatingProcess);
  u16(0); // hours after cutoff
  u8(0); // minutes after cutoff
  u8(1); // unit of time range: hour
  u32(field.forecastHours);
  u8(field.level.type);
  u8(0); // scale factor of first fixed surface
  u32(field.level.value);
  u8(255); // no second fixed surface
  u8(0xff);
  u32(0xffffffff);

  // Section 5: data representation, template 5.0 (simple packing)
  u32(SECTION_BYTES.s5);
  u8(5);
  u32(present);
  u16(0);
  view.setFloat32(at, reference); // below 2^24: exact in float32 unless constant
  at += 4;
  s16(0); // binary scale factor E
  s16(decimalScale);
  u8(nbits);
  u8(0); // original values: floating point

  // Section 6: bitmap (1 = value present), MSB first
  u32(s6);
  u8(6);
  u8(bitmap ? 0 : 255);
  if (bitmap) {
    for (let k = 0; k < count; k++) {
      const byte = at + (k >> 3);
      if (!Number.isNaN(field.values[k]!)) out[byte] = out[byte]! | (0x80 >> (k & 7));
    }
    at += Math.ceil(count / 8);
  }

  // Section 7: packed values, MSB first, zero-padded to a byte
  u32(s7);
  u8(7);
  if (nbits > 0) {
    let acc = 0;
    let accBits = 0;
    for (let k = 0; k < present; k++) {
      // acc holds < 8 bits before the shift, so it stays below 2^31.
      acc = (acc << nbits) | (ints[k]! - min);
      accBits += nbits;
      while (accBits >= 8) {
        accBits -= 8;
        out[at++] = (acc >>> accBits) & 0xff;
      }
      acc &= (1 << accBits) - 1;
    }
    if (accBits > 0) out[at++] = (acc << (8 - accBits)) & 0xff;
  }

  // Section 8: end
  out.set([0x37, 0x37, 0x37, 0x37], at); // "7777"
  at += 4;
  if (at !== total) throw new Error(`GRIB length mismatch: wrote ${at} of ${total} bytes`);
  return out;
}

function checkLattice(lattice: GribLattice): void {
  const { n, ni, nj, kS, kN, kW, kE, stepMicro } = lattice;
  if (![n, ni, nj, kS, kN, kW, kE, stepMicro].every(Number.isInteger) || n < 1 || ni < 1 || nj < 1 ||
      stepMicro !== Math.round(1e7 / n) || kN - kS + 1 !== nj || kE - kW + 1 !== ni) {
    throw new Error('GRIB lattice is inconsistent');
  }
  if (kS < -9 * n || kN > 9 * n || kW < -18 * n || kE > 18 * n) {
    throw new Error('GRIB lattice is outside the globe');
  }
}

function checkUint(name: string, value: number, bytes: 1 | 2 | 4): void {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * bytes)) {
    throw new Error(`GRIB ${name} out of range: ${value}`);
  }
}

function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}
