import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { CHECK_FILE_NAMES, contentHash } from '@deepweather/engine';
import { gunzipText } from '../src/lib/snapshotCodec.js';
import { polarContentFindings } from '../../scripts/polar-content-rules.mjs';
import { makeCheck } from './helpers/checkFiles.js';

// Saving a copy of a browser-saved check to a file (lib/checkFile.js): the gzip of
// the engine's check file, version 1, holding every file of the check exactly as
// it was saved. Scratch IndexedDB only (fake-indexeddb, a fresh factory per test).
// the earlier demo check: its manifest names only the files a browser-saved check has
// (the latest one also names the served-only changes.json and verification.json)
const demoDir = resolve(import.meta.dirname, 'fixtures/demo/snapshots/snapshot_v2_8ca29e5bd5a065f3');
const id = 'snapshot_v2_8ca29e5bd5a065f3';
const hex = '8ca29e5bd5a065f3';
// The files a browser-saved check holds (writeSnapshot), the manifest last as writeAll stores it.
const SAVED = ['decision-inputs.json', 'findings.json', 'briefing.json', 'route.json', 'plume.json', 'warnings.json', 'synoptic.json', 'snapshot.json'];
const demoFiles = () => SAVED.map((filename) => ({ filename, content: readFileSync(join(demoDir, filename), 'utf8') }));
const NOW = Date.parse('2026-11-15T12:00:00Z');
const savedOf = (check) => Object.entries(check.files).map(([filename, content]) => ({ filename, content }))
  .sort((a, b) => (a.filename === 'snapshot.json') - (b.filename === 'snapshot.json'));

let localSnapshots, checkFile;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
  checkFile = await import('../src/lib/checkFile.js');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function putPlain(snapshotId, files) {
  await localSnapshots.list(); // creates the database
  const db = await new Promise((done) => { const request = indexedDB.open('passage-local-snapshots'); request.onsuccess = () => done(request.result); });
  await new Promise((done, fail) => {
    const transaction = db.transaction('files', 'readwrite');
    for (const { filename, content } of files) transaction.objectStore('files').put({ key: `${snapshotId}/${filename}`, snapshot_id: snapshotId, filename, content });
    transaction.oncomplete = done;
    transaction.onerror = () => fail(transaction.error);
  });
  db.close();
}

async function exported(snapshotId = id) {
  const { name, bytes } = await checkFile.prepareCheckFile(snapshotId, { nowMs: NOW });
  return { name, bytes, document: JSON.parse(await gunzipText(bytes)) };
}

it('writes a gzip document whose files are the stored texts, whose decision inputs hash to the id', async () => {
  const files = demoFiles();
  await localSnapshots.writeAll(id, files);
  const { name, bytes, document } = await exported();
  expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
  const departure = JSON.parse(files[0].content).departureUtc;
  expect(name).toBe(`passage-check-${departure.slice(0, 10)}-${hex}.json.gz`);
  expect(document).toMatchObject({
    format: 'passage-checks', format_version: 1, exported_at: '2026-11-15T12:00:00.000Z', exported_by: checkFile.CHECK_FILE_EXPORTED_BY,
  });
  expect(checkFile.CHECK_FILE_EXPORTED_BY).toMatch(/^Passage engine \d+\.\d+\.\d+$/);
  expect(document.checks).toHaveLength(1);
  expect(document.checks[0].snapshot_id).toBe(id);
  const texts = Object.fromEntries(files.map(({ filename, content }) => [filename, content]));
  expect(document.checks[0].files).toEqual(texts);
  expect(Object.keys(document.checks[0].files)).toEqual(CHECK_FILE_NAMES.filter((file) => file in texts));
  expect(`snapshot_v2_${contentHash(JSON.parse(document.checks[0].files['decision-inputs.json']))}`).toBe(id);
});

it('exports the same original text from a check stored compressed and one stored plain', async () => {
  await localSnapshots.writeAll(id, demoFiles());
  const compressed = await exported();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
  checkFile = await import('../src/lib/checkFile.js');
  await putPlain(id, demoFiles());
  const plain = await exported();
  expect(plain.name).toBe(compressed.name);
  expect(JSON.stringify(plain.document)).toBe(JSON.stringify(compressed.document));
});

it('passes the real no-polar-data rules for a check whose route keeps the boat reference, scaling and leg speeds', async () => {
  // what a computed route records about the boat: its id, the percent of its polar, per-leg speeds
  // (inside the decision inputs, so the check is whole and the copy's own re-read accepts it)
  const check = await makeCheck({ routeExtras: {
    provenance: { routing_request: { polar_id: 'invented-boat-34', polar_scaling: 0.9 }, polar_ref: 'invented-boat-34' },
    legs: [{ through_water_kt: 6.4, speed_over_ground_kt: 6.9 }],
  } });
  await localSnapshots.writeAll(check.snapshotId, savedOf(check));
  for (const content of Object.values(check.files)) expect(polarContentFindings(content)).toEqual([]);
  const { bytes } = await checkFile.prepareCheckFile(check.snapshotId, { nowMs: NOW });
  const document = JSON.parse(await gunzipText(bytes));
  expect(document.checks[0].files['route.json']).toContain('"polar_id": "invented-boat-34"');
  expect(document.checks[0].files['route.json']).toContain('"through_water_kt": 6.4');
});

describe('a check whose text matches a no-polar-data rule', () => {
  // Invented, polar-shaped and built at run time, so this source file holds no polar table.
  const key = ['speeds', 'kt'].join('_');
  it.each([
    ['route.json', (route) => ({ ...route, boat: { [key]: [[4.1, 5.2], [6.3, 7.4]] } })],
    ['findings.json', (findings) => ({ ...findings, vpp: { angles: [40] } })],
  ])('in %s is refused, and no file is made', async (target, plant) => {
    const files = demoFiles().map((file) => (file.filename === target
      ? { ...file, content: JSON.stringify(plant(JSON.parse(file.content)), null, 2) } : file));
    await localSnapshots.writeAll(id, files);
    await expect(checkFile.prepareCheckFile(id, { nowMs: NOW })).rejects.toMatchObject({ name: 'CheckFileError', code: 'polar' });
    // the public result: the refusal, and no bytes handed to a download
    expect(await saveWithDownloads()).toEqual({ outcome: checkFile.COPY.polar, downloads: [] });
  });
});

describe('boat polar data the raw-text rules do not see', () => {
  const key = ['speeds', 'kt'].join('_');
  it.each([
    ['behind a unicode-escaped key', (text) => text.replace('{', `{"debug": {"${key.replace('_', '\\u005f')}": [[4.1, 5.2], [6.3, 7.4]]},`)],
    ['inside a JSON string', (text) => text.replace('{', `{"debug": ${JSON.stringify(JSON.stringify({ [key]: [[4.1, 5.2], [6.3, 7.4]] }))},`)],
  ])('is refused %s, and no file is made', async (_case, plant) => {
    const files = demoFiles().map((file) => (file.filename === 'findings.json' ? { ...file, content: plant(file.content) } : file));
    expect(polarContentFindings(files.find((file) => file.filename === 'findings.json').content)).toEqual([]);
    await localSnapshots.writeAll(id, files);
    await expect(checkFile.prepareCheckFile(id, { nowMs: NOW })).rejects.toMatchObject({ code: 'polar' });
    expect(await saveWithDownloads()).toEqual({ outcome: checkFile.COPY.polar, downloads: [] });
  });
});

/** saveCheckFile's outcome and the Blobs it handed to a download. */
async function saveWithDownloads() {
  const downloads = [];
  URL.createObjectURL = vi.fn((blob) => { downloads.push(blob); return 'blob:copy'; });
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    return { outcome: await checkFile.saveCheckFile(id), downloads };
  } finally {
    click.mockRestore();
    delete URL.createObjectURL;
    delete URL.revokeObjectURL;
  }
}

/** The demo check with one stored file's text changed. */
const withFile = (filename, change) => demoFiles().map((file) => (file.filename === filename ? { ...file, content: change(file.content) } : file));
const manifestWith = (change) => withFile('snapshot.json', (text) => JSON.stringify(change(JSON.parse(text)), null, 2));

describe('a stored check that is not the check its id names is damaged, and no file is made', () => {
  it.each([
    ['its manifest names another snapshot_id', manifestWith((m) => ({ ...m, snapshot_id: 'snapshot_v2_0123456789abcdef' }))],
    ['its manifest names another decision_hash', manifestWith((m) => ({ ...m, decision_hash: '0123456789abcdef' }))],
    ['its manifest is not identity 2', manifestWith((m) => ({ ...m, identity_version: 1 }))],
    ['its manifest is not JSON', withFile('snapshot.json', (text) => text.slice(0, 40))],
    ['its manifest names no files', manifestWith(({ artifacts: _files, ...m }) => m)],
    ['its manifest leaves out a required file', manifestWith((m) => ({ ...m, artifacts: { ...m.artifacts, briefing: undefined } }))],
    ['its decision inputs no longer hash to the id', withFile('decision-inputs.json', (text) => text.replace('"departureUtc":"', '"departureUtc":"2'))],
    ['its decision inputs are not JSON', withFile('decision-inputs.json', (text) => `${text}}`)],
    ['its findings name another check', withFile('findings.json', (text) => text.replace(`"snapshot_id": "${id}"`, '"snapshot_id": "snapshot_v2_0123456789abcdef"'))],
    ['its findings name another decision_hash', withFile('findings.json', (text) => text.replace(`"decision_hash": "${hex}"`, '"decision_hash": "0123456789abcdef"'))],
  ])('when %s', async (_case, files) => {
    expect(files.some((file, i) => file.content !== demoFiles()[i].content)).toBe(true);
    await localSnapshots.writeAll(id, files);
    await expect(checkFile.prepareCheckFile(id)).rejects.toMatchObject({ code: 'damaged' });
    expect(await saveWithDownloads()).toEqual({ outcome: checkFile.COPY.damaged, downloads: [] });
  });

  it('when a stored record holds content that is not text', async () => {
    await putPlain(id, demoFiles().map((file) => (file.filename === 'route.json' ? { ...file, content: { name: 'not text' } } : file)));
    await expect(checkFile.prepareCheckFile(id)).rejects.toMatchObject({ code: 'damaged' });
    expect(await saveWithDownloads()).toEqual({ outcome: checkFile.COPY.damaged, downloads: [] });
  });
});

describe('a copy that cannot be made', () => {
  it('refuses a manifest that names a file a check file cannot hold, rather than leave it out', async () => {
    await localSnapshots.writeAll(id, [{ filename: 'notes.json', content: '{}' }, ...manifestWith((m) => ({ ...m, artifacts: { ...m.artifacts, notes: 'notes.json' } }))]);
    await expect(checkFile.prepareCheckFile(id)).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('notes.json') });
    expect(await saveWithDownloads()).toEqual({ outcome: checkFile.COPY.failed, downloads: [] });
  });

  it('refuses a copy over the import\'s caps (64 MB of text, 16 MB compressed), plainly', async () => {
    await localSnapshots.writeAll(id, demoFiles());
    const { bytes } = await checkFile.prepareCheckFile(id, { nowMs: NOW });
    const textBytes = new TextEncoder().encode(await gunzipText(bytes)).byteLength;
    await expect(checkFile.prepareCheckFile(id, { nowMs: NOW, maxTextBytes: textBytes - 1 })).rejects.toMatchObject({ code: 'tooLarge' });
    await expect(checkFile.prepareCheckFile(id, { nowMs: NOW, maxTextBytes: textBytes })).resolves.toMatchObject({ name: expect.any(String) });
    await expect(checkFile.prepareCheckFile(id, { nowMs: NOW, maxCompressedBytes: bytes.byteLength - 1 })).rejects.toMatchObject({ code: 'tooLarge' });
    expect(checkFile.COPY.tooLarge).toBe('tooLarge');
  });

  it('copies a check whose save time is ahead of this device, with no time bound', async () => {
    const files = demoFiles().map((file) => (file.filename === 'snapshot.json'
      ? { ...file, content: file.content.replace(/"created_at": "[^"]+"/, '"created_at": "2099-01-01T00:00:00.000Z"') } : file));
    await localSnapshots.writeAll(id, files);
    const { bytes } = await checkFile.prepareCheckFile(id, { nowMs: NOW });
    expect(JSON.parse(JSON.parse(await gunzipText(bytes)).checks[0].files['snapshot.json']).created_at).toBe('2099-01-01T00:00:00.000Z');
  });

  it('hands a made copy to the download once', async () => {
    await localSnapshots.writeAll(id, demoFiles());
    const { outcome, downloads } = await saveWithDownloads();
    expect(outcome).toBe(checkFile.COPY.made);
    expect(downloads).toHaveLength(1);
    expect(JSON.parse(await gunzipText(new Uint8Array(await downloads[0].arrayBuffer()))).checks[0].snapshot_id).toBe(id);
  });

  it('reports a file the check names but this browser cannot read', async () => {
    await localSnapshots.writeAll(id, demoFiles().filter((file) => file.filename !== 'plume.json'));
    await expect(checkFile.prepareCheckFile(id)).rejects.toMatchObject({ code: 'unreadable' });
    expect(await checkFile.saveCheckFile(id)).toBe(checkFile.COPY.unreadable);
  });

  it('reports a check that is not saved here', async () => {
    expect(await checkFile.saveCheckFile(id)).toBe(checkFile.COPY.unreadable);
  });

  it('fails plainly without CompressionStream, never writing an uncompressed file', async () => {
    await localSnapshots.writeAll(id, demoFiles());
    vi.stubGlobal('CompressionStream', undefined);
    expect(checkFile.canSaveCheckFile()).toBe(false);
    await expect(checkFile.prepareCheckFile(id)).rejects.toMatchObject({ code: 'failed' });
  });

  it('refuses a check id that is not a v2 id', async () => {
    await expect(checkFile.prepareCheckFile('20260720T060000Z_44d2cd5f_64ea971e')).rejects.toMatchObject({ code: 'failed' });
  });

  it('never exports a record that is not a file of a check, such as an import marker', async () => {
    await localSnapshots.writeAll(id, [{ filename: 'imported.json', content: '{"from":"file"}' }, ...demoFiles()]);
    const { document } = await exported();
    expect(Object.keys(document.checks[0].files)).not.toContain('imported.json');
  });
});
