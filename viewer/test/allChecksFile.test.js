import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { CHECK_FILE_NAMES, checkFileEntryLine, parseCheckFileEntryLine } from '@deepweather/engine';
import { checkFileOf, fileOf, makeCheck } from './helpers/checkFiles.js';

// Saving every check of this browser to one version-2 file (lib/allChecksFile.js).
// Scratch IndexedDB only (fake-indexeddb, a fresh factory per test); checks the
// engine makes (helpers/checkFiles.js). jsdom's Blob has no stream(), so the core
// is given Node's Blob (node:buffer), as the page's own Blob would be used.
vi.setConfig({ testTimeout: 60_000 });

const NOW = Date.parse('2026-11-16T09:00:00Z');
const savedFiles = (check) => Object.entries(check.files).map(([filename, content]) => ({ filename, content }))
  .sort((a, b) => (a.filename === 'snapshot.json') - (b.filename === 'snapshot.json'));
const withManifest = (check, change) => ({
  ...check,
  files: { ...check.files, 'snapshot.json': JSON.stringify(change(JSON.parse(check.files['snapshot.json'])), null, 2) },
});

let checks; // oldest first: four saved at different times, the last two at the same time
let localSnapshots, lib, lines, validators;
beforeAll(async () => {
  checks = [
    await makeCheck({ passageId: 'passage-a', nowMs: Date.parse('2026-07-19T10:00:00Z') }),
    await makeCheck({ passageId: 'passage-b', departureUtc: '2026-07-21T06:00:00Z', nowMs: Date.parse('2026-07-19T11:00:00Z'), name: 'Île d’Yeu → Brest 🌊' }),
    await makeCheck({ passageId: 'passage-c', departureUtc: '2026-07-22T06:00:00Z', nowMs: Date.parse('2026-07-19T12:00:00Z') }),
    await makeCheck({ passageId: 'passage-d', departureUtc: '2026-07-23T06:00:00Z', nowMs: Date.parse('2026-07-19T12:00:00Z') }),
  ];
});
beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
  lib = await import('../src/lib/allChecksFile.js');
  lines = await import('../src/lib/checkFileLines.js');
  ({ checkFileValidators: validators } = await import('../src/lib/generated/checkFileValidators.js'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const store = (check) => localSnapshots.writeAll(check.snapshotId, savedFiles(check));
const deps = (overrides = {}) => ({
  store: localSnapshots,
  loadValidators: () => import('../src/lib/generated/checkFileValidators.js'),
  compressor: () => new CompressionStream('gzip'),
  Blob: NodeBlob,
  pause: () => new Promise((done) => { setTimeout(done, 0); }),
  ...overrides,
});
const make = (options = {}, overrides = {}) => lib.makeAllChecksFile(deps(overrides), { nowMs: NOW, ...options });

/** The backup read back as the import will: the header, each line proven, the trailer. */
async function readBack(blob) {
  const items = [];
  for await (const item of lines.readCheckFileLines(blob)) items.push(item);
  const proven = items.filter((item) => typeof item === 'string').map((line) => parseCheckFileEntryLine(line, {
    nowMs: NOW, boundTime: true, validateFile: (name, value) => validators[name]?.(value) === true,
  }));
  return { header: items[0], trailer: items.at(-1), proven };
}
const ids = (list) => list.map((check) => check.snapshotId);
const expectedFiles = (check) => Object.fromEntries(CHECK_FILE_NAMES.filter((name) => name in check.files).map((name) => [name, check.files[name]]));

describe('a backup of every check', () => {
  it('holds each check proven, its texts exactly as stored, newest first and by id at the same time', async () => {
    for (const check of [checks[2], checks[0], checks[3], checks[1]]) await store(check);
    const progress = [];
    const result = await make({ onProgress: (step) => progress.push(step) });
    expect(result.outcome).toBe(lib.ALL_CHECKS.made);
    const sameTime = ids(checks.slice(2)).sort();
    expect(result.included).toEqual([...sameTime, checks[1].snapshotId, checks[0].snapshotId]);
    expect(result.counts).toEqual({ included: 4, legacy: 0, damaged: 0, unreadable: 0, polar: 0, tooLarge: 0, overCap: 0, futureDated: 0 });
    expect(result.name).toBe('passage-all-checks-2026-11-16-0900Z.json.gz');
    expect(progress).toEqual([1, 2, 3, 4].map((index) => ({ index, total: 4 })));
    const back = await readBack(result.blob);
    expect(back.header).toEqual({ kind: 'v3', header: { exportedAt: '2026-11-16T09:00:00.000Z', exportedBy: expect.stringMatching(/^Passage engine \d+\.\d+\.\d+$/) } });
    expect(back.trailer).toEqual({ trailer: { ok: true, checks: 4 } });
    back.proven.forEach((line, i) => {
      expect(line.ok).toBe(true);
      const check = checks.find((each) => each.snapshotId === result.included[i]);
      expect(line.check.snapshotId).toBe(check.snapshotId);
      expect(line.check.files).toEqual(expectedFiles(check));
    });
    // the line is exactly the engine's for those files
    const first = [];
    for await (const item of lines.readCheckFileLines(result.blob)) if (typeof item === 'string') first.push(item);
    expect(`${first[2]}\n`).toBe(checkFileEntryLine(checks[1]));
  });

  it('leaves out and counts legacy, damaged, unreadable, polar-shaped and too-large checks, writing the others', async () => {
    const [good, other] = checks;
    await store(good);
    await store(other);
    // a legacy identity-1 check
    const legacyId = '20260720T060000Z_44d2cd5f_64ea971e';
    await localSnapshots.writeAll(legacyId, [{ filename: 'snapshot.json', content: JSON.stringify({ snapshot_id: legacyId, created_at: '2026-07-19T13:00:00Z' }) }]);
    // damaged: another verdict in the manifest
    const damaged = await makeCheck({ passageId: 'passage-damaged', nowMs: Date.parse('2026-07-19T14:00:00Z') });
    await store(withManifest(damaged, (m) => ({ ...m, verdict_state: m.verdict_state === 'within' ? 'exceeds' : 'within' })));
    // unreadable: a file its manifest names is not stored
    const unreadable = await makeCheck({ passageId: 'passage-unreadable', nowMs: Date.parse('2026-07-19T15:00:00Z') });
    await localSnapshots.writeAll(unreadable.snapshotId, savedFiles(unreadable).filter((file) => file.filename !== 'plume.json'));
    // polar-shaped: invented, built at run time, in a field the findings contract leaves open
    const polar = await makeCheck({ passageId: 'passage-polar', nowMs: Date.parse('2026-07-19T16:00:00Z') });
    const key = ['speeds', 'kt'].join('_');
    await store({ ...polar, files: { ...polar.files, 'findings.json': JSON.stringify({ ...JSON.parse(polar.files['findings.json']), debug: { [key]: [[4.1, 5.2], [6.3, 7.4]] } }) } });
    // too large for a line under a cap set between the others and it
    const large = await makeCheck({ passageId: 'passage-large', nowMs: Date.parse('2026-07-19T17:00:00Z'), routeExtras: { note: 'x'.repeat(60_000) } });
    await store(large);
    const lineBytes = new TextEncoder().encode(checkFileEntryLine(large)).byteLength - 2;
    expect(new TextEncoder().encode(checkFileEntryLine(good)).byteLength).toBeLessThan(lineBytes);
    const result = await make({ caps: { lineBytes } });
    expect(result.outcome).toBe(lib.ALL_CHECKS.made);
    expect(result.counts).toEqual({ included: 2, legacy: 1, damaged: 1, unreadable: 1, polar: 1, tooLarge: 1, overCap: 0, futureDated: 0 });
    expect(result.included).toEqual([other.snapshotId, good.snapshotId]);
    const back = await readBack(result.blob);
    expect(back.proven.map((line) => line.ok && line.check.snapshotId)).toEqual(result.included);
    // reasons are logged nowhere with content: nothing was logged at all
    expect(console.error).not.toHaveBeenCalled();
  });

  it('includes an imported check, without its import marker', async () => {
    const { importCheckFile } = await import('../src/lib/checkImport.js');
    const imported = await importCheckFile(fileOf((await checkFileOf(checks[1])).bytes), { servedIds: new Set(), nowMs: NOW });
    expect(imported.outcome).toBe('imported');
    expect(await localSnapshots.read(checks[1].snapshotId, 'imported.json')).not.toBeNull();
    await store(checks[0]);
    const result = await make();
    expect(result.included).toEqual([checks[1].snapshotId, checks[0].snapshotId]);
    const back = await readBack(result.blob);
    expect(Object.keys(back.proven[0].check.files)).not.toContain('imported.json');
    expect(back.proven[0].check.files).toEqual(expectedFiles(checks[1]));
  });

  it('never holds two checks: every file of one check is read after the previous check\'s line is written', async () => {
    for (const check of checks) await store(check);
    const log = [];
    const spyStore = {
      list: () => localSnapshots.list(),
      read: async (id, name) => { log.push(`read ${id}`); return localSnapshots.read(id, name); },
    };
    const decoder = new TextDecoder();
    const compressor = () => {
      const tap = new TransformStream({
        transform(chunk, controller) {
          const id = /snapshot_v2_[0-9a-f]{16}/.exec(decoder.decode(chunk.subarray(0, 64)))?.[0];
          if (id) log.push(`write ${id}`);
          controller.enqueue(chunk);
        },
      });
      return { writable: tap.writable, readable: tap.readable.pipeThrough(new CompressionStream('gzip')) };
    };
    const result = await make({}, { store: spyStore, compressor });
    expect(result.outcome).toBe(lib.ALL_CHECKS.made);
    // one block per check, in file order: its reads, then its line
    const blocks = [];
    for (const entry of log) {
      const [what, id] = entry.split(' ');
      if (blocks.at(-1)?.id !== id) {
        expect(blocks.at(-1)?.written ?? true).toBe(true);
        blocks.push({ id, written: false });
      }
      if (what === 'write') blocks.at(-1).written = true;
      else expect(blocks.at(-1).written).toBe(false);
    }
    expect(blocks.map((block) => block.id)).toEqual(result.included);
  });
});

describe('caps', () => {
  beforeEach(async () => { for (const check of checks) await store(check); });

  it('stops before the check cap with the newest checks, the rest counted', async () => {
    const result = await make({ caps: { checks: 2 } });
    expect(result.outcome).toBe(lib.ALL_CHECKS.made);
    expect(result.included).toHaveLength(2);
    expect(result.included).toEqual(lib.backupOrder(await localSnapshots.list()).slice(0, 2).map((entry) => entry.snapshot_id));
    expect(result.counts).toMatchObject({ included: 2, overCap: 2 });
    expect((await readBack(result.blob)).trailer).toEqual({ trailer: { ok: true, checks: 2 } });
  });

  it('stops before the inflated cap and before the compressed cap, the file whole', async () => {
    const line = Math.max(...checks.map((check) => new TextEncoder().encode(checkFileEntryLine(check)).byteLength));
    expect(Math.min(...checks.map((check) => new TextEncoder().encode(checkFileEntryLine(check)).byteLength)) * 2).toBeGreaterThan(line + 400);
    const inflated = await make({ caps: { inflatedBytes: 300 + line + 100 } });
    expect(inflated.counts).toMatchObject({ included: 1, overCap: 3 });
    expect((await readBack(inflated.blob)).proven).toHaveLength(1);
    // room for one line beside the compressor margin (1 MiB): the second no longer fits once the first is handed over
    const cap = 1024 * 1024 + Math.ceil(line * 1.01) + 200;
    const compressed = await make({ caps: { compressedBytes: cap } });
    expect(compressed.outcome).toBe(lib.ALL_CHECKS.made);
    expect(compressed.counts.included).toBeGreaterThanOrEqual(1);
    expect(compressed.counts.included + compressed.counts.overCap).toBe(4);
    expect(compressed.counts.overCap).toBeGreaterThan(0);
    expect(compressed.blob.size).toBeLessThanOrEqual(cap);
    expect((await readBack(compressed.blob)).proven.every((each) => each.ok)).toBe(true);
  });

  it('gives nothing when not even the newest check fits', async () => {
    expect(await make({ caps: { inflatedBytes: 1000 } })).toEqual({ outcome: lib.ALL_CHECKS.empty, counts: expect.objectContaining({ included: 0, overCap: 4 }) });
  });
});

describe('stopping and failing', () => {
  beforeEach(async () => { for (const check of checks) await store(check); });

  it('stops on an abort mid-way and keeps nothing', async () => {
    const controller = new AbortController();
    const result = await make({ signal: controller.signal, onProgress: ({ index }) => { if (index === 2) controller.abort(); } });
    expect(result).toEqual({ outcome: lib.ALL_CHECKS.stopped });
    const before = new AbortController();
    before.abort();
    expect(await make({ signal: before.signal })).toEqual({ outcome: lib.ALL_CHECKS.stopped });
  });

  it('fails the whole backup when a line does not read back as written', async () => {
    // a compressor that alters one byte inside the second check's line, after its id
    let seen = 0;
    const compressor = () => {
      const alter = new TransformStream({
        transform(chunk, controller) {
          if (chunk.byteLength > 1000 && (seen += 1) === 2) { const copy = chunk.slice(); copy[500] = copy[500] === 0x41 ? 0x42 : 0x41; controller.enqueue(copy); } else controller.enqueue(chunk);
        },
      });
      return { writable: alter.writable, readable: alter.readable.pipeThrough(new CompressionStream('gzip')) };
    };
    expect(await make({}, { compressor })).toEqual({ outcome: lib.ALL_CHECKS.failed, reason: 'verify' });
  });

  it('fails the whole backup when the gzip it made is damaged', async () => {
    const compressor = () => {
      const gzip = new CompressionStream('gzip');
      let flipped = false;
      const damage = new TransformStream({
        transform(chunk, controller) {
          if (!flipped && chunk.byteLength > 100) { flipped = true; const copy = chunk.slice(); copy[50] ^= 0xff; controller.enqueue(copy); } else controller.enqueue(chunk);
        },
      });
      return { writable: gzip.writable, readable: gzip.readable.pipeThrough(damage) };
    };
    expect(await make({}, { compressor })).toEqual({ outcome: lib.ALL_CHECKS.failed, reason: 'verify' });
  });
});

describe('nothing to save', () => {
  it('says so for an empty store, only legacy checks and only damaged ones', async () => {
    expect(await make()).toEqual({ outcome: lib.ALL_CHECKS.empty, counts: { included: 0, legacy: 0, damaged: 0, unreadable: 0, polar: 0, tooLarge: 0, overCap: 0, futureDated: 0 } });
    const legacyId = '20260720T060000Z_44d2cd5f_64ea971e';
    await localSnapshots.writeAll(legacyId, [{ filename: 'snapshot.json', content: JSON.stringify({ snapshot_id: legacyId }) }]);
    expect(await make()).toMatchObject({ outcome: lib.ALL_CHECKS.empty, counts: { legacy: 1, included: 0 } });
    await store(withManifest(checks[0], (m) => ({ ...m, check_sequence: 0 })));
    expect(await make()).toMatchObject({ outcome: lib.ALL_CHECKS.empty, counts: { legacy: 1, damaged: 1, included: 0 } });
  });
});

it('prepareAllChecksFile makes the file with the page\'s own Blob, store and compressor', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  await store(checks[0]);
  const result = await lib.prepareAllChecksFile({ nowMs: NOW });
  expect(result).toMatchObject({ outcome: lib.ALL_CHECKS.made, included: [checks[0].snapshotId] });
  expect((await readBack(result.blob)).proven[0].ok).toBe(true);
});

describe('review round', () => {
  /** Letters gzip cannot shrink much (a fixed pseudo-random sequence per seed). */
  const noise = (n, seed) => {
    let state = seed;
    return Array.from({ length: n }, () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return String.fromCharCode(97 + ((state >>> 0) % 26)); }).join('');
  };
  /** A gzip compressor that hands over nothing until it is closed, then everything (and `pad` extra bytes). */
  const lateCompressor = (pad = 0) => () => {
    const gzip = new CompressionStream('gzip');
    const held = [];
    const late = new TransformStream({
      transform(chunk) { held.push(chunk); },
      flush(controller) { for (const chunk of held) controller.enqueue(chunk); if (pad) controller.enqueue(new Uint8Array(pad)); },
    });
    return { writable: gzip.writable, readable: gzip.readable.pipeThrough(late) };
  };

  it('counts checks saved after the export time as future-dated: written, and refused by the import until then', async () => {
    const ahead = await makeCheck({ passageId: 'passage-ahead', nowMs: Date.parse('2099-01-01T00:00:00Z') });
    await store(ahead);
    await store(checks[0]);
    const result = await make();
    expect(result.counts).toMatchObject({ included: 2, futureDated: 1 });
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.resetModules();
    const { importChecksFile } = await import('../src/lib/checkImportMany.js');
    const imported = await importChecksFile(result.blob, { servedIds: new Set(), nowMs: NOW });
    expect(imported.outcomes).toMatchObject({ imported: 1, futureTime: 1 });
  });

  it('drops the oldest checks instead of failing when a late compressor makes the file pass the cap', async () => {
    const heavy = [];
    // about 0.5 MB of noise each (strings under the 64 KiB a route string may hold), in the route and the decision inputs
    const notes = (i) => Array.from({ length: 9 }, (_, j) => noise(60_000, 2463534242 + i * 31 + j));
    for (let i = 0; i < 4; i++) heavy.push(await makeCheck({ passageId: `passage-heavy-${i}`, nowMs: Date.parse(`2026-07-19T1${i}:00:00Z`), routeExtras: { notes: notes(i) } }));
    for (const check of heavy) await store(check);
    const sizes = heavy.map((check) => new TextEncoder().encode(checkFileEntryLine(check)).byteLength);
    const cap = Math.max(...sizes) + Math.ceil(Math.max(...sizes) / 16_000) * 5 + 2000;
    const whole = await make({ caps: { compressedBytes: 1e9 } });
    // the four together are larger than the cap, which each one alone fits
    expect(whole.blob.size).toBeGreaterThan(cap);
    const labels = () => ({ 'local|passage|passage-heavy-0': 'Heavy zero', 'local|passage|passage-heavy-3': 'Heavy three' });
    const result = await make({ caps: { compressedBytes: cap, compressorMargin: 0 } }, { compressor: lateCompressor(), labels });
    expect(result.outcome).toBe(lib.ALL_CHECKS.made);
    // the pass that made the file again wrote the same names line, the names of dropped passages included
    let names = null;
    for await (const item of lines.readCheckFileLines(result.blob)) if (item.names) ({ names } = item);
    expect(names).toEqual([{ passage_id: 'passage-heavy-0', name: 'Heavy zero' }, { passage_id: 'passage-heavy-3', name: 'Heavy three' }]);
    expect(result.blob.size).toBeLessThanOrEqual(cap);
    expect(result.counts.included).toBeGreaterThanOrEqual(1);
    expect(result.counts.included + result.counts.overCap).toBe(4);
    expect(result.included).toEqual(whole.included.slice(0, result.counts.included));
    expect((await readBack(result.blob)).proven.every((line) => line.ok)).toBe(true);
  }, 60_000); // CPU-bound: four ~0.5 MB checks built, gzipped and read back; 4.5 s alone, 15 s on a loaded machine

  it('fails as too large only when not even one check fits', async () => {
    for (const check of checks) await store(check);
    const line = Math.max(...checks.map((check) => new TextEncoder().encode(checkFileEntryLine(check)).byteLength));
    const cap = line + Math.ceil(line / 16_000) * 5 + 2000;
    const result = await make({ caps: { compressedBytes: cap, compressorMargin: 0 } }, { compressor: lateCompressor(2 * cap) });
    expect(result).toEqual({ outcome: lib.ALL_CHECKS.failed, reason: 'tooLarge' });
  });

  it('counts a check deleted during the export as unreadable, and leaves out one saved during it', async () => {
    for (const check of checks.slice(0, 3)) await store(check);
    const [newest] = lib.backupOrder(await localSnapshots.list());
    let saved = false;
    const spyStore = {
      list: () => localSnapshots.list(),
      read: async (id, name) => {
        const text = await localSnapshots.read(id, name);
        if (!saved) { saved = true; await store(checks[3]); }
        if (id === newest.snapshot_id && name === 'snapshot.json') await localSnapshots.remove(id);
        return text;
      },
    };
    const result = await make({}, { store: spyStore });
    expect(result.counts).toMatchObject({ included: 2, unreadable: 1 });
    expect(result.included).not.toContain(newest.snapshot_id);
    expect(result.included).not.toContain(checks[3].snapshotId);
    expect(await localSnapshots.exists(checks[3].snapshotId)).toBe(true);
  });
});

describe('version 3: the names the sailor gave their passages', () => {
  const namesOf = async (blob) => {
    for await (const item of lines.readCheckFileLines(blob)) if (item.names || item.namesUnreadable) return item;
    return null;
  };
  const textOf = async (blob) => {
    const { gunzipSync } = await import('node:zlib');
    return gunzipSync(new Uint8Array(await blob.arrayBuffer())).toString('utf8');
  };

  it('carries, sorted, each passage with a check in the export and a name given here, cleaned; never a legacy, served or check-less one', async () => {
    await store(checks[0]);
    await store(checks[1]);
    const legacyId = '20260720T060000Z_44d2cd5f_64ea971e';
    await localSnapshots.writeAll(legacyId, [{ filename: 'snapshot.json', content: JSON.stringify({ snapshot_id: legacyId, created_at: '2026-07-19T13:00:00Z' }) }]);
    // an imported-only passage the sailor renamed
    const { importCheckFile } = await import('../src/lib/checkImport.js');
    expect((await importCheckFile(fileOf((await checkFileOf(checks[2])).bytes), { servedIds: new Set(), nowMs: NOW })).outcome).toBe('imported');
    const labels = {
      'local|passage|passage-b': 'Bravo',
      'local|passage|passage-a': '  Alpha\u202E  run ',
      'local|passage|passage-c': 'Charlie (imported)',
      'local|passage|passage-zzz': 'No check here',
      'served|passage|passage-b': 'Served',
      [`local|snapshot|${legacyId}`]: 'Legacy',
      'local|passage|passage-d': '\u200B',
    };
    const result = await make({}, { labels: () => labels });
    expect(result.outcome).toBe(lib.ALL_CHECKS.made);
    expect(await namesOf(result.blob)).toEqual({ names: [
      { passage_id: 'passage-a', name: 'Alpha run' },
      { passage_id: 'passage-b', name: 'Bravo' },
      { passage_id: 'passage-c', name: 'Charlie (imported)' },
    ] });
    // always a names line, empty when no passage has a name
    const none = await make();
    expect(await namesOf(none.blob)).toEqual({ names: [] });
    expect((await textOf(none.blob)).split('\n')[1]).toBe('{"names":[],"names_digest":"cbf29ce484222325"}');
  });

  it('round-trips: export, import into a clean store, export again give the same lines, the names line included', async () => {
    const { passageLabels } = await import('../src/lib/passageLabels.js');
    await store(checks[0]);
    await store(checks[1]);
    passageLabels.set('local|passage|passage-a', 'Île d’Yeu → Brest 🌊');
    const deps3 = { labels: () => passageLabels.all() };
    const first = await make({}, deps3);
    const firstText = await textOf(first.blob);
    expect(firstText.split('\n')[1]).toContain('"name":"Île d’Yeu → Brest 🌊"');
    localStorage.clear();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.resetModules();
    ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
    lib = await import('../src/lib/allChecksFile.js');
    const { importChecksFile } = await import('../src/lib/checkImportMany.js');
    const fresh = (await import('../src/lib/passageLabels.js')).passageLabels;
    const imported = await importChecksFile(first.blob, { servedIds: new Set(), nowMs: NOW });
    expect(imported).toMatchObject({ end: 'complete', appliedNames: [{ key: 'local|passage|passage-a', name: 'Île d’Yeu → Brest 🌊' }] });
    const second = await make({}, { labels: () => fresh.all() });
    expect(await textOf(second.blob)).toBe(firstText);
  });

  it('fails the whole backup when the names line does not read back as written', async () => {
    await store(checks[0]);
    const compressor = () => {
      const alter = new TransformStream({
        transform(chunk, controller) {
          if (new TextDecoder().decode(chunk.subarray(0, 9)) === '{"names":') {
            const copy = chunk.slice();
            const at = new TextDecoder().decode(copy).indexOf('Alpha');
            copy[at] = 0x42; // "Blpha": the digest no longer holds
            controller.enqueue(copy);
          } else controller.enqueue(chunk);
        },
      });
      return { writable: alter.writable, readable: alter.readable.pipeThrough(new CompressionStream('gzip')) };
    };
    expect(await make({}, { compressor, labels: () => ({ 'local|passage|passage-a': 'Alpha' }) })).toEqual({ outcome: lib.ALL_CHECKS.failed, reason: 'verify' });
  });
});
