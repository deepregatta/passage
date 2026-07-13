/**
 * PFT1 forecast-tile codec (TypeScript side). Must decode the shared golden
 * fixtures identically to the pipeline's Python reference implementation —
 * the format is specified in docs/forecast-tiles-spec.md and the header is
 * validated by contracts/forecast-tile.schema.json.
 *
 * Decode input is the UNCOMPRESSED tile bytes; gzip is the transport's job.
 * The encoder exists for tests and fixture tooling only — production tiles
 * are built by the pipeline.
 */

const MAGIC = 0x50465431; // "PFT1" big-endian read of the 4 magic bytes

export interface TimeAxis {
  base: string;
  offsets_h: number[];
}

export interface TileVariable {
  name: string;
  axis: string;
  dtype: 'i16' | 'i8';
  scale: number;
  offset?: number;
  missing?: number;
  per_member?: boolean;
  byte_offset: number;
  byte_length: number;
}

export interface TileHeader {
  spec: 'PFT1';
  schema_version: number;
  layer: string;
  model: string;
  run_id: string;
  cycle: string;
  generated_at: string;
  tile_id: string;
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nlat: number;
  nlon: number;
  time_axes: Record<string, TimeAxis>;
  member_count: number;
  variables: TileVariable[];
  provenance?: Record<string, unknown>;
}

export interface DecodedTile {
  header: TileHeader;
  /** float32 values in C-order [member?][time][lat][lon]; NaN = missing */
  arrays: Record<string, Float32Array>;
}

const DTYPE_INFO = {
  i16: { bytes: 2, sentinel: -32768, min: -32767, max: 32767 },
  i8: { bytes: 1, sentinel: -128, min: -127, max: 127 },
} as const;

function expectedLength(header: TileHeader, variable: TileVariable): number {
  const axis = header.time_axes[variable.axis];
  if (!axis) throw new Error(`variable ${variable.name}: unknown time axis ${variable.axis}`);
  const spatial = axis.offsets_h.length * header.nlat * header.nlon;
  return variable.per_member ? header.member_count * spatial : spatial;
}

export function decodeTile(buf: Uint8Array): DecodedTile {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 8 || view.getUint32(0, false) !== MAGIC) {
    throw new Error('not a PFT1 tile');
  }
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(
    new TextDecoder().decode(buf.subarray(8, 8 + headerLen)),
  ) as TileHeader;
  if (header.spec !== 'PFT1') throw new Error(`unsupported spec: ${header.spec}`);
  const payloadStart = 8 + headerLen + ((4 - ((8 + headerLen) % 4)) % 4);

  const arrays: Record<string, Float32Array> = {};
  for (const variable of header.variables) {
    const info = DTYPE_INFO[variable.dtype];
    const count = variable.byte_length / info.bytes;
    if (count !== expectedLength(header, variable)) {
      throw new Error(`variable ${variable.name}: byte_length disagrees with header dims`);
    }
    // arrays are 4-byte aligned within the tile, but the tile bytes themselves
    // may sit at an arbitrary offset inside a pooled ArrayBuffer — copy then
    const start = buf.byteOffset + payloadStart + variable.byte_offset;
    const aligned =
      start % info.bytes === 0
        ? buf.buffer
        : buf.slice(payloadStart + variable.byte_offset, payloadStart + variable.byte_offset + variable.byte_length).buffer;
    const alignedStart = aligned === buf.buffer ? start : 0;
    const raw =
      variable.dtype === 'i16'
        ? new Int16Array(aligned, alignedStart, count)
        : new Int8Array(aligned, alignedStart, count);
    const missing = variable.missing ?? info.sentinel;
    const offset = variable.offset ?? 0;
    const values = new Float32Array(count);
    for (let k = 0; k < count; k++) {
      const r = raw[k]!;
      values[k] = r === missing ? NaN : Math.fround(r * variable.scale + offset);
    }
    arrays[variable.name] = values;
  }
  return { header, arrays };
}

/** Test/fixture-only encoder; production tiles come from the pipeline. */
export function encodeTile(
  header: Omit<TileHeader, 'variables'> & {
    variables: Array<Omit<TileVariable, 'byte_offset' | 'byte_length'>>;
  },
  arrays: Record<string, ArrayLike<number>>,
): Uint8Array {
  const variables: TileVariable[] = [];
  const payloadParts: Uint8Array[] = [];
  let offsetBytes = 0;
  for (const spec of header.variables) {
    const info = DTYPE_INFO[spec.dtype];
    const values = arrays[spec.name];
    if (!values) throw new Error(`missing array for variable ${spec.name}`);
    const scale = spec.scale;
    const varOffset = spec.offset ?? 0;
    const raw = spec.dtype === 'i16' ? new Int16Array(values.length) : new Int8Array(values.length);
    for (let k = 0; k < values.length; k++) {
      const v = values[k]!;
      raw[k] = Number.isNaN(v)
        ? info.sentinel
        : Math.min(info.max, Math.max(info.min, Math.round((v - varOffset) / scale)));
    }
    const bytes = new Uint8Array(raw.buffer);
    const pad = (4 - (bytes.byteLength % 4)) % 4;
    const variable: TileVariable = {
      ...spec,
      offset: varOffset,
      missing: spec.missing ?? info.sentinel,
      byte_offset: offsetBytes,
      byte_length: bytes.byteLength,
    };
    const fullLength = expectedLength({ ...header, variables: [] } as TileHeader, variable);
    if (values.length !== fullLength) {
      throw new Error(`variable ${spec.name}: length ${values.length} != expected ${fullLength}`);
    }
    variables.push(variable);
    payloadParts.push(bytes, new Uint8Array(pad));
    offsetBytes += bytes.byteLength + pad;
  }

  const headerJson = new TextEncoder().encode(JSON.stringify({ ...header, variables }));
  const headerPad = (4 - ((8 + headerJson.byteLength) % 4)) % 4;
  const total =
    8 + headerJson.byteLength + headerPad + payloadParts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, false);
  view.setUint32(4, headerJson.byteLength, true);
  out.set(headerJson, 8);
  let cursor = 8 + headerJson.byteLength + headerPad;
  for (const part of payloadParts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}
