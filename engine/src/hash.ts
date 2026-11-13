/**
 * Deterministic, dependency-free content hashing for ids and input fingerprints.
 * FNV-1a 64-bit — NOT cryptographic; identifiers and tile corruption checks.
 */

export function fnv1a64Hex(input: string | Uint8Array): string {
  return fnv1a64HexParts([input]);
}

/**
 * FNV-1a 64 of the concatenated inputs, without copying them into one buffer.
 * A string contributes its UTF-16 code units (0 to 0xffff each), a byte array
 * its bytes, exactly as `h ^= unit; h = h * 0x100000001b3 mod 2^64` on BigInt.
 * The state is kept in four 16-bit limbs (h3 most significant): the prime is
 * 2^40 + 0x1b3, so a limb times 0x1b3 stays at its place and a limb times
 * 2^40 lands two limbs up, times 0x100. Every intermediate stays below 2^27,
 * so plain numbers are exact. engine/test/hash.test.ts proves the result
 * equal to the BigInt definition on fixtures, goldens and random strings.
 */
export function fnv1a64HexParts(parts: ReadonlyArray<string | Uint8Array>): string {
  // offset basis 0xcbf29ce484222325
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (const input of parts) {
    const n = input.length;
    if (typeof input === 'string') {
      for (let i = 0; i < n; i++) {
        h0 ^= input.charCodeAt(i);
        const t0 = h0 * 0x1b3;
        const t1 = h1 * 0x1b3 + (t0 >>> 16);
        const t2 = h2 * 0x1b3 + h0 * 0x100 + (t1 >>> 16);
        h3 = (h3 * 0x1b3 + h1 * 0x100 + (t2 >>> 16)) & 0xffff;
        h0 = t0 & 0xffff;
        h1 = t1 & 0xffff;
        h2 = t2 & 0xffff;
      }
    } else {
      for (let i = 0; i < n; i++) {
        h0 ^= input[i]!;
        const t0 = h0 * 0x1b3;
        const t1 = h1 * 0x1b3 + (t0 >>> 16);
        const t2 = h2 * 0x1b3 + h0 * 0x100 + (t1 >>> 16);
        h3 = (h3 * 0x1b3 + h1 * 0x100 + (t2 >>> 16)) & 0xffff;
        h0 = t0 & 0xffff;
        h1 = t1 & 0xffff;
        h2 = t2 & 0xffff;
      }
    }
  }
  const hex = (limb: number) => limb.toString(16).padStart(4, '0');
  return hex(h3) + hex(h2) + hex(h1) + hex(h0);
}

/** Canonical JSON: stable key order, no whitespace — so hashes are byte-stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export function contentHash(value: unknown): string {
  return fnv1a64Hex(canonicalJson(value));
}

/**
 * True when nothing reachable from `value` can change any more: every object
 * and array in it is frozen, plain (an Object or Array prototype, or none) and,
 * for objects, made of data properties only (no getter can answer differently
 * later). Freezing cannot be undone, so once true it stays true. Array items
 * are read as values, not descriptor by descriptor, which would cost more than
 * the hash: arrays parsed from JSON or built by the engine have no accessors.
 */
function isDeepFrozenData(value: unknown): boolean {
  if (typeof value === 'function') return false;
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      if (typeof item === 'function' || (item !== null && typeof item === 'object' && !isDeepFrozenData(item))) return false;
    }
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .every(descriptor => 'value' in descriptor && isDeepFrozenData(descriptor.value));
}

const cachedDigests = new WeakMap<object, string>();

/**
 * contentHash(value), computed once per object when the value is deep-frozen
 * plain data (see isDeepFrozenData), and every time otherwise. The cache is
 * keyed by the object itself, so a copy, or any value that could still change,
 * is hashed afresh: a cached digest is always the digest of what the object
 * holds now. Used for the prepared current grid, which every action loads,
 * freezes and then hashes once for its record, routing and audit alike.
 */
export function cachedContentHash(value: unknown): string {
  if (value === null || typeof value !== 'object') return contentHash(value);
  const known = cachedDigests.get(value);
  if (known !== undefined) return known;
  const frozen = isDeepFrozenData(value);
  const digest = contentHash(value);
  if (frozen) cachedDigests.set(value, digest);
  return digest;
}
