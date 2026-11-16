import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { crc32, gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildCheckFile, checkFileEntryLine, checkFileHeaderLine, checkFileNamesLine, checkFileText, checkFileTrailerLine, parseCheckFileEntryLine,
} from '@deepweather/engine';
import {
  CheckFileLinesError, LINES, LINE_CAPS, checkFileLinesOf, endsWithSize, holdsSecondMember, memberSizeBytes, readCheckFileLines,
} from '../src/lib/checkFileLines.js';
import { makeCheck } from './helpers/checkFiles.js';

// The version-2 check file's stream reader (lib/checkFileLines.js), over crafted gzip.
// jsdom's File has no stream(), so these use Node's own File and Blob (node:buffer),
// which implement the File API's stream() with the same WHATWG streams the
// DecompressionStream here takes; a stand-in Blob feeds the compressed bytes in chunks
// of a chosen size, and checkFileLinesOf takes inflated chunks split exactly where a
// test wants them.
vi.setConfig({ testTimeout: 30_000 });

const encoder = new TextEncoder();
const bytesOf = (text) => (typeof text === 'string' ? encoder.encode(text) : text);
const gzip = (text) => new Uint8Array(gzipSync(bytesOf(text)));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
};
const fileOf = (bytes) => new NodeFile([bytes], 'passage-all-checks.json.gz', { type: 'application/gzip' });

/** A Blob whose stream gives the compressed bytes `size` at a time, and records its pulls and a cancel. */
function chunkedFile(bytes, size, log = {}) {
  const blob = new NodeBlob([bytes]);
  return {
    size: bytes.byteLength,
    slice: (start, end) => blob.slice(start, end),
    stream() {
      let offset = 0;
      return new ReadableStream({
        pull(controller) {
          if (offset >= bytes.byteLength) { controller.close(); return; }
          log.pulls = (log.pulls ?? 0) + 1;
          controller.enqueue(bytes.slice(offset, offset += size));
        },
        cancel() { log.cancelled = true; },
      });
    },
  };
}

/** A Blob whose stream gives the compressed bytes cut at the given offsets. */
function cutFile(bytes, cuts) {
  const blob = new NodeBlob([bytes]);
  return {
    size: bytes.byteLength,
    slice: (start, end) => blob.slice(start, end),
    stream() {
      const edges = [0, ...cuts, bytes.byteLength];
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i >= edges.length - 1) { controller.close(); return; }
          controller.enqueue(bytes.slice(edges[i], edges[i + 1]));
          i += 1;
        },
      });
    },
  };
}

/** Everything the reader yields, and the code it stopped with (null when it did not throw). */
async function read(file, options) {
  const items = [];
  try {
    for await (const item of readCheckFileLines(file, options)) items.push(item);
  } catch (error) {
    if (!(error instanceof CheckFileLinesError)) throw error;
    return { items, code: error.code, detail: error.message };
  }
  return { items, code: null };
}
async function readChunks(chunks, options) {
  const items = [];
  try {
    for await (const item of checkFileLinesOf((async function* source() { for (const chunk of chunks) yield bytesOf(chunk); })(), options)) items.push(item);
  } catch (error) {
    if (!(error instanceof CheckFileLinesError)) throw error;
    return { items, code: error.code };
  }
  return { items, code: null };
}

const exportedAt = '2026-11-15T12:00:00.000Z';
const exportedBy = 'Passage engine 0.2.0';
const HEADER = checkFileHeaderLine({ exportedAt, exportedBy });
const header = { exportedAt, exportedBy };
// a line the reader frames and never parses: any compact text will do for framing cases
const fakeLine = (n) => `{"snapshot_id":"${'x'.repeat(Math.max(0, n - 18))}"}`.slice(0, n);
const backup = (lines, trailer = checkFileTrailerLine(lines.length)) => HEADER + lines.map((line) => `${line}\n`).join('') + trailer;
/** A line of `n` letters gzip cannot shrink (a fixed pseudo-random sequence), so a file of it is read in many chunks. */
const noiseLine = (n) => {
  let state = 2463534242;
  const letters = Array.from({ length: n - 18 }, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return String.fromCharCode(97 + ((state >>> 0) % 26));
  });
  return `{"snapshot_id":"${letters.join('')}"}`;
};

let checks;
let v1Text;
beforeAll(async () => {
  checks = [await makeCheck(), await makeCheck({ passageId: 'passage-lines', departureUtc: '2026-07-21T06:00:00Z', name: 'Île d’Yeu → Brest 🌊' })];
  v1Text = checkFileText(buildCheckFile({ ...checks[0], exportedAt, exportedBy }));
});

describe('a version-2 file', () => {
  const text = () => HEADER + checks.map((check) => checkFileEntryLine(check)).join('') + checkFileTrailerLine(checks.length);

  it('yields the header, each real check line as text, then the trailer; every line proves', async () => {
    const { items, code } = await read(fileOf(gzip(text())));
    expect(code).toBeNull();
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({ kind: 'v2', header });
    expect(items[3]).toEqual({ trailer: { ok: true, checks: 2 } });
    items.slice(1, 3).forEach((line, i) => {
      expect(typeof line).toBe('string');
      expect(line).toBe(checkFileEntryLine(checks[i]).slice(0, -1));
      const result = parseCheckFileEntryLine(line, { nowMs: Date.parse('2026-11-16T09:00:00Z'), boundTime: true });
      expect(result.ok).toBe(true);
      expect(result.check.files).toEqual(Object.fromEntries(Object.entries(result.check.files).map(([name]) => [name, checks[i].files[name]])));
      expect(Object.keys(result.check.files).sort()).toEqual(Object.keys(checks[i].files).sort());
    });
  });

  it('reads the same through compressed chunks of 1, 7 and 4096 bytes', async () => {
    const whole = await read(fileOf(gzip(text())));
    const bytes = gzip(text());
    for (const size of [7, 4096]) expect(await read(chunkedFile(bytes, size))).toEqual(whole);
    // one byte at a time, on a smaller file (each byte is a stream read)
    const small = gzip(backup(['{"snapshot_id":"Île d’Yeu 🌊"}', fakeLine(300)]));
    expect(await read(chunkedFile(small, 1))).toEqual(await read(fileOf(small)));
  });

  it('accepts a trailer without its final newline, and no checks', async () => {
    expect((await read(fileOf(gzip(text().slice(0, -1))))).items.at(-1)).toEqual({ trailer: { ok: true, checks: 2 } });
    expect(await read(fileOf(gzip(HEADER + checkFileTrailerLine(0))))).toEqual({ items: [{ kind: 'v2', header }, { trailer: { ok: true, checks: 0 } }], code: null });
  });

  it('throws a trailer that does not hold, never yielding it, after the lines before it', async () => {
    const counted = await read(fileOf(gzip(backup([fakeLine(40)], checkFileTrailerLine(2)))));
    expect(counted).toEqual({ items: [{ kind: 'v2', header }, fakeLine(40)], code: LINES.trailer, detail: 'a number of checks other than the checks read' });
    const spaced = await read(fileOf(gzip(backup([], '{"end":"passage-checks", "checks":0}\n'))));
    expect(spaced).toMatchObject({ items: [{ kind: 'v2', header }], code: LINES.trailer });
    const many = await read(fileOf(gzip(backup([], '{"end":"passage-checks","checks":1001}\n'))));
    expect(many).toMatchObject({ items: [{ kind: 'v2', header }], code: LINES.checkCount });
  });

  it('yields each line before the file proves whole: a damaged file gives the lines before the damage, then throws', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => fakeLine(40 + i));
    // a bad CRC, the gzip footer arriving alone: all 50 lines, then the refusal, and never { trailer }
    const crc = gzip(backup(lines));
    crc[crc.byteLength - 8] ^= 0xff;
    const footer = await read(cutFile(crc, [crc.byteLength - 8]));
    expect(footer.items).toEqual([{ kind: 'v2', header }, ...lines]);
    expect(footer.code).toBe(LINES.corrupt);
    // the text cut inside the last line: the 49 before it, then truncated
    const cut = backup(lines);
    const short = await read(fileOf(gzip(cut.slice(0, cut.lastIndexOf(lines[49]) + 10))));
    expect(short).toMatchObject({ items: [{ kind: 'v2', header }, ...lines.slice(0, 49)], code: LINES.truncated });
  });

  it('stops at a header of a newer format version', async () => {
    const newer = `${JSON.stringify({ format: 'passage-checks', format_version: 4, exported_at: exportedAt, exported_by: exportedBy })}\n`;
    expect(await read(fileOf(gzip(newer + checkFileTrailerLine(0))))).toMatchObject({ items: [], code: LINES.newerVersion });
  });
});

describe('a version-1 document is handed to the stage 1 path', () => {
  it.each([
    ['a real check file', () => v1Text],
    ['a real check file with one final newline', () => `${v1Text}\n`],
    ['a small document', () => '{"format":"passage-checks","format_version":1,"checks":[]}'],
    ['a small document with one final newline', () => '{"format":"passage-checks","format_version":1,"checks":[]}\n'],
    ['a document of version 2 with its checks (stage 1 says "newer")', () => JSON.stringify({ ...JSON.parse(v1Text), format_version: 2 })],
    ['a document with a carriage return and newline at its end', () => `${v1Text}\r\n`],
    ['a version-2 header ended by a carriage return', () => `${HEADER.slice(0, -1)}\r\n${checkFileTrailerLine(0)}`],
    ['GPX', () => '<?xml version="1.0"?><gpx version="1.1"><rte/></gpx>'],
    ['no text at all', () => ''],
    ['a first line that is not UTF-8', () => new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x0a])],
    ['a byte order mark before the header', () => `\ufeff${HEADER}${checkFileTrailerLine(0)}`],
    ['64 KiB of zeros without a newline (a bomb starts this way)', () => new Uint8Array(64 * 1024)],
  ])('%s', async (_case, make) => {
    expect(await read(fileOf(gzip(make())))).toEqual({ items: [{ kind: 'v1' }], code: null });
  });

  it('stopping after its first 4 KiB, then releasing the stream', async () => {
    const log = {};
    // a document gzip cannot shrink much: what the decompressor reads ahead stays small beside it
    const bytes = gzip(JSON.stringify({ ...JSON.parse(v1Text), noise: noiseLine(2_000_000) }));
    expect(await read(chunkedFile(bytes, 1024, log))).toEqual({ items: [{ kind: 'v1' }], code: null });
    expect(log.pulls * 1024).toBeLessThan(bytes.byteLength / 4);
    await new Promise((done) => setTimeout(done, 0));
    expect(log.cancelled).toBe(true);
  });

  it('and gzip cut short or followed by another member inside the first line, which stage 1 then judges', async () => {
    const small = gzip('{"format":"passage-checks","format_version":1,"checks":[]}');
    expect(await read(fileOf(small.slice(0, small.byteLength - 6)))).toEqual({ items: [{ kind: 'v1' }], code: null });
    expect(await read(fileOf(concat(small, gzip('more'))))).toEqual({ items: [{ kind: 'v1' }], code: null });
  });

  it('and stage 1 gives its own outcome for the same File', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { readCheckFile } = await import('../src/lib/checkImport.js');
    const newer = fileOf(gzip(JSON.stringify({ ...JSON.parse(v1Text), format_version: 2 })));
    expect((await read(newer)).items).toEqual([{ kind: 'v1' }]);
    await expect(readCheckFile(newer, { servedIds: new Set() })).rejects.toMatchObject({ outcome: 'newer-version' });
    const valid = fileOf(gzip(v1Text));
    expect((await read(valid)).items).toEqual([{ kind: 'v1' }]);
    await expect(readCheckFile(valid, { servedIds: new Set(), nowMs: Date.parse('2026-11-16T09:00:00Z') })).resolves.toMatchObject({ check: { snapshotId: checks[0].snapshotId } });
  });
});

describe('before reading', () => {
  it('refuses bytes that are not gzip, an empty file and no file', async () => {
    expect(await read(fileOf(encoder.encode(HEADER)))).toMatchObject({ code: LINES.notGzip });
    expect(await read(fileOf(new Uint8Array()))).toMatchObject({ code: LINES.notGzip });
    expect(await read(null)).toMatchObject({ code: LINES.notCheckFile });
  });

  it('refuses a file over the compressed cap from its size alone, and reads one at the cap', async () => {
    const bytes = gzip(backup([]));
    const log = {};
    expect(await read(chunkedFile(bytes, 64, log), { caps: { compressedBytes: bytes.byteLength - 1 } })).toEqual({ items: [], code: LINES.tooLarge, detail: 'over the file cap' });
    expect(log.pulls).toBeUndefined();
    expect((await read(fileOf(bytes), { caps: { compressedBytes: bytes.byteLength } })).code).toBeNull();
    expect(LINE_CAPS.compressedBytes).toBe(2 ** 30);
  });
});

describe('the caps, while bytes are still buffering', () => {
  it('reads a check line of exactly the line cap and refuses one byte more', async () => {
    const caps = { lineBytes: 300 };
    const exact = await read(fileOf(gzip(backup([fakeLine(300)]))), { caps });
    expect(exact.code).toBeNull();
    expect(exact.items[1]).toHaveLength(300);
    expect(await read(fileOf(gzip(backup([fakeLine(301)]))), { caps })).toMatchObject({ items: [{ kind: 'v2' }], code: LINES.tooLarge, detail: 'a line over its cap' });
    // counted in bytes, not characters
    const wide = `{"snapshot_id":"${'é'.repeat(141)}"}`;
    expect(encoder.encode(wide).byteLength).toBe(300);
    expect((await read(fileOf(gzip(backup([wide]))), { caps })).code).toBeNull();
    expect((await read(fileOf(gzip(backup([`${wide.slice(0, -2)}éx"}`]))), { caps })).code).toBe(LINES.tooLarge);
  });

  it('stops a line still growing past its cap without reading on', async () => {
    let pulled = 0;
    const endless = (async function* source() {
      yield encoder.encode(HEADER);
      for (;;) { pulled += 1; yield new Uint8Array(1024).fill(0x78); }
    })();
    const items = [];
    await expect((async () => { for await (const item of checkFileLinesOf(endless, { caps: { lineBytes: 10 * 1024 } })) items.push(item); })())
      .rejects.toMatchObject({ code: LINES.tooLarge });
    expect(items).toEqual([{ kind: 'v2', header }]);
    expect(pulled).toBe(11);
  });

  it('holds the header and the trailer to 4 KiB each', async () => {
    expect(LINE_CAPS.edgeBytes).toBe(4096);
    const headerLength = HEADER.length - 1;
    expect((await read(fileOf(gzip(backup([]))), { caps: { edgeBytes: headerLength } })).items[0]).toEqual({ kind: 'v2', header });
    // one byte short of the header: it cannot be a version-2 header, so the file is version 1's to judge
    expect(await read(fileOf(gzip(backup([]))), { caps: { edgeBytes: headerLength - 1 } })).toEqual({ items: [{ kind: 'v1' }], code: null });
    const trailerOf = (n) => `{"end":"passage-checks","checks":0${' '.repeat(n - 35)}}`;
    expect(trailerOf(4096)).toHaveLength(4096);
    // read whole at exactly the cap (then refused for its spaces), refused as too large one byte over
    expect(await read(fileOf(gzip(backup([], trailerOf(4096)))))).toMatchObject({ code: LINES.trailer, detail: 'not one compact JSON object' });
    expect(await read(fileOf(gzip(backup([], `${trailerOf(4097)}\n`))))).toMatchObject({ code: LINES.tooLarge, detail: 'a trailer over its cap' });
  });

  it('holds all lines to the inflated cap', async () => {
    const text = backup([fakeLine(200), fakeLine(200)]);
    const size = encoder.encode(text).byteLength;
    expect((await read(fileOf(gzip(text)), { caps: { inflatedBytes: size } })).code).toBeNull();
    expect(await read(fileOf(gzip(text)), { caps: { inflatedBytes: size - 1 } })).toMatchObject({ code: LINES.tooLarge, detail: 'over the inflated cap' });
    expect(LINE_CAPS.inflatedBytes).toBe(8 * 2 ** 30);
  });

  it('refuses a check line past the check cap before yielding it', async () => {
    const lines = [fakeLine(40), fakeLine(40), fakeLine(40)];
    expect((await read(fileOf(gzip(backup(lines.slice(0, 2)))), { caps: { checks: 2 } })).code).toBeNull();
    const over = await read(fileOf(gzip(backup(lines))), { caps: { checks: 2 } });
    expect(over).toMatchObject({ code: LINES.checkCount });
    expect(over.items).toHaveLength(3);
    expect(LINE_CAPS.checks).toBe(1000);
  });
});

describe('the end of the file', () => {
  it('refuses a file ending before its trailer, never yielding a last line without its newline', async () => {
    const complete = backup([fakeLine(40), fakeLine(50)]);
    expect(await read(fileOf(gzip(HEADER + `${fakeLine(40)}\n`)))).toMatchObject({ items: [{ kind: 'v2' }, fakeLine(40)], code: LINES.truncated });
    const cut = await read(fileOf(gzip(HEADER + `${fakeLine(40)}\n${fakeLine(50)}`)));
    expect(cut).toMatchObject({ items: [{ kind: 'v2' }, fakeLine(40)], code: LINES.truncated });
    expect(await read(fileOf(gzip(HEADER)))).toMatchObject({ items: [{ kind: 'v2' }], code: LINES.truncated });
    expect(await read(fileOf(gzip(HEADER.slice(0, -1))))).toMatchObject({ items: [], code: LINES.truncated });
    // the trailer itself cut short
    expect(await read(fileOf(gzip(complete.slice(0, -10))))).toMatchObject({ code: LINES.truncated });
    expect(await read(fileOf(gzip(complete.slice(0, HEADER.length + 41 + 5))))).toMatchObject({ code: LINES.truncated });
  });

  it('refuses gzip cut short or corrupt before the trailer as truncated', async () => {
    const bytes = gzip(backup(checks.map((check) => checkFileEntryLine(check).slice(0, -1))));
    // the first kilobyte arrives alone, so the header is handed over before the damage (Node's
    // decompressor drops the output of a write that fails: damage in the first write leaves the
    // header unread, and the file is then version 1's to judge, which stage 1 refuses as damaged)
    const cut = await read(cutFile(bytes.slice(0, Math.floor(bytes.byteLength / 2)), [1000]));
    expect([cut.items[0], cut.code, cut.items.some((item) => item?.trailer)]).toEqual([{ kind: 'v2', header }, LINES.truncated, false]);
    const bad = bytes.slice();
    bad.fill(7, 2000, 2100);
    const damaged = await read(cutFile(bad, [1000]));
    expect([damaged.items[0], damaged.code, damaged.items.some((item) => item?.trailer)]).toEqual([{ kind: 'v2', header }, LINES.truncated, false]);
    expect([[{ kind: 'v1' }], [{ kind: 'v2', header }]]).toContainEqual((await read(fileOf(bad))).items.slice(0, 1));
  });

  it.each([
    ['another line', '{"x":1}\n'],
    ['a second newline', '\n'],
    ['one byte', 'x'],
  ])('refuses %s after the trailer', async (_case, extra) => {
    const result = await read(fileOf(gzip(backup([fakeLine(40)]) + extra)));
    expect(result).toMatchObject({ code: LINES.trailingData, detail: 'data after the trailer' });
    expect(result.items.some((item) => item?.trailer)).toBe(false);
  });

  it('refuses bytes after the gzip member that are not one', async () => {
    const bytes = gzip(backup([fakeLine(40)]));
    expect(await read(fileOf(concat(bytes, encoder.encode('junk'))))).toMatchObject({ code: LINES.trailingData });
    expect(await read(fileOf(concat(bytes, new Uint8Array(8))))).toMatchObject({ code: LINES.trailingData });
  });

  it.each([
    ['after the trailer', () => [gzip(backup([fakeLine(40)])), gzip(`${fakeLine(40)}\n`)]],
    ['that is empty', () => [gzip(backup([fakeLine(40)])), gzip('')]],
    ['holding the rest of the lines', () => {
      const text = backup([fakeLine(40), fakeLine(50)]);
      const at = HEADER.length + 41;
      return [gzip(text.slice(0, at)), gzip(text.slice(at))];
    }],
  ])('refuses a second gzip member %s', async (_case, members) => {
    const result = await read(fileOf(concat(...members())));
    expect(result).toMatchObject({ code: LINES.secondMember });
    expect(result.items.some((item) => item?.trailer)).toBe(false);
  });

  it('refuses a second member even where the decompressor stops cleanly at the end of the first', async () => {
    // the stream gives the first member only, as a decompressor that ignores what follows would read it; the file goes on
    const first = gzip(backup([fakeLine(40)]));
    const whole = new NodeBlob([concat(first, gzip(`${fakeLine(40)}\n`))]);
    const lenient = { size: whole.size, slice: (start, end) => whole.slice(start, end), stream: () => new NodeBlob([first]).stream() };
    expect(await read(lenient)).toMatchObject({ code: LINES.secondMember, detail: 'the file goes on after its gzip member' });
    expect((await read(fileOf(first))).code).toBeNull();
  });

  it('refuses a second member even where the decompressor would read on into it', async () => {
    // stand-in inflated chunks as such a decompressor gives them, ending cleanly: the size check at the end tells
    const text = backup([fakeLine(40)]);
    const result = await readChunks([text], { ended: async (inflated) => (inflated === encoder.encode(text).byteLength ? LINES.secondMember : null) });
    expect(result.code).toBe(LINES.secondMember);
  });

  it('refuses a member whose own check fails: corrupt once the trailer was read, truncated when the decompressor drops it', async () => {
    const bytes = gzip(backup([fakeLine(40)]));
    bytes[bytes.byteLength - 8] ^= 0xff; // the CRC
    // the gzip trailer arriving alone: every line is handed over before the check fails
    expect(await read(cutFile(bytes, [bytes.byteLength - 8]))).toMatchObject({ code: LINES.corrupt, items: [{ kind: 'v2' }, fakeLine(40)] });
    // read whole, Node's decompressor drops the failing chunk's output, trailer included
    const large = gzip(backup([noiseLine(200_000)]));
    large[large.byteLength - 8] ^= 0xff;
    expect([LINES.corrupt, LINES.truncated]).toContain((await read(fileOf(large))).code);
  });
});

describe('decoding', () => {
  it.each([
    ['an invalid byte', [0xff]],
    ['an overlong encoding', [0xc0, 0x80]],
    ['an encoded surrogate', [0xed, 0xa0, 0x80]],
    ['a sequence cut by the newline', [0xe2, 0x82]],
  ])('refuses a check line with %s', async (_case, bad) => {
    const line = concat(encoder.encode('{"snapshot_id":"'), new Uint8Array(bad), encoder.encode('"}\n'));
    const text = concat(encoder.encode(HEADER), line, encoder.encode(checkFileTrailerLine(1)));
    expect(await read(fileOf(gzip(text)))).toMatchObject({ items: [{ kind: 'v2' }], code: LINES.invalidUtf8 });
  });

  it('decodes characters split across inflated chunks, and a trailer split before its prefix is whole', async () => {
    const line = '{"snapshot_id":"Île d’Yeu 🌊 é"}';
    const bytes = encoder.encode(backup([line]));
    // every split point inside the check line and the trailer's first bytes
    const start = HEADER.length;
    for (let at = start; at < bytes.byteLength; at++) {
      const result = await readChunks([bytes.slice(0, at), bytes.slice(at)]);
      expect(result, `split at ${at}`).toEqual({ items: [{ kind: 'v2', header }, line, { trailer: { ok: true, checks: 1 } }], code: null });
    }
    // one byte at a time
    expect(await readChunks(Array.from(bytes, (byte) => new Uint8Array([byte])))).toEqual({ items: [{ kind: 'v2', header }, line, { trailer: { ok: true, checks: 1 } }], code: null });
  });

  it('keeps a carriage return before the newline in the line, which the engine refuses', async () => {
    const line = checkFileEntryLine(checks[0]).slice(0, -1);
    const { items, code } = await read(fileOf(gzip(backup([`${line}\r`]))));
    expect(code).toBeNull();
    expect(items[1]).toBe(`${line}\r`);
    expect(parseCheckFileEntryLine(items[1])).toMatchObject({ ok: false, problem: 'damaged-line', reason: 'line' });
    expect(await read(fileOf(gzip(backup([], '{"end":"passage-checks","checks":0}\r\n'))))).toMatchObject({ code: LINES.trailer });
  });

  it('keeps a byte order mark at the start of a line, which no JSON line may start with', async () => {
    const line = checkFileEntryLine(checks[0]).slice(0, -1);
    const { items } = await read(fileOf(gzip(backup([`\ufeff${line}`]))));
    expect(items[1].charCodeAt(0)).toBe(0xfeff);
    expect(parseCheckFileEntryLine(items[1])).toMatchObject({ ok: false, reason: 'line' });
  });
});

describe('stopping', () => {
  it('stops at once for a signal already aborted, reading nothing', async () => {
    const log = {};
    const controller = new AbortController();
    controller.abort();
    expect(await read(chunkedFile(gzip(backup([])), 16, log), { signal: controller.signal })).toMatchObject({ items: [], code: LINES.aborted });
    expect(log.pulls).toBeUndefined();
  });

  it('stops on an abort mid-read and releases the stream', async () => {
    const log = {};
    const controller = new AbortController();
    const bytes = gzip(backup(checks.map((check) => checkFileEntryLine(check).slice(0, -1))));
    const items = [];
    const reading = (async () => {
      for await (const item of readCheckFileLines(chunkedFile(bytes, 256, log), { signal: controller.signal })) {
        items.push(item);
        if (item.kind === 'v2') controller.abort();
      }
    })();
    await expect(reading).rejects.toMatchObject({ code: LINES.aborted });
    expect(items).toEqual([{ kind: 'v2', header }]);
    await new Promise((done) => setTimeout(done, 0));
    expect(log.cancelled).toBe(true);
    expect(log.pulls * 256).toBeLessThan(bytes.byteLength);
  });

  it('releases the stream when it refuses a file and when the caller stops early', async () => {
    // larger than what Node's decompressor reads ahead (128 KiB), so the source is still open when the read stops
    const bytes = gzip(backup([noiseLine(1_000_000), fakeLine(40)]));
    const refused = {};
    expect((await read(chunkedFile(bytes, 64, refused), { caps: { lineBytes: 1000 } })).code).toBe(LINES.tooLarge);
    const stopped = {};
    for await (const item of readCheckFileLines(chunkedFile(bytes, 64, stopped))) if (item.kind === 'v2') break;
    await new Promise((done) => setTimeout(done, 0));
    expect(refused.cancelled).toBe(true);
    expect(stopped.cancelled).toBe(true);
  });
});

describe('review round', () => {
  it('holds a line once, as text: never more than its first seven bytes, whatever its length and characters', async () => {
    const line = `{"snapshot_id":"${'é🌊x'.repeat(150_000)}"}`;
    const bytes = encoder.encode(backup([line, fakeLine(40)]));
    const chunks = [];
    for (let at = 0; at < bytes.byteLength; at += 65_536) chunks.push(bytes.slice(at, at + 65_536));
    let heldBytes = 0;
    let heldChars = 0;
    const probe = (held) => { heldBytes = Math.max(heldBytes, held.heldBytes); heldChars = Math.max(heldChars, held.heldChars); };
    const result = await readChunks(chunks, { probe });
    expect(result.code).toBeNull();
    expect(result.items[1]).toBe(line);
    expect(heldBytes).toBeLessThanOrEqual(7);
    expect(heldChars).toBeLessThanOrEqual(line.length);
    expect(encoder.encode(line).byteLength).toBeGreaterThan(1_000_000);
  });

  it('reads gzip whose header carries FEXTRA, FNAME, FCOMMENT and FHCRC before the data', async () => {
    const plain = gzip(backup([fakeLine(40)]));
    const extra = encoder.encode('\x1f\x8b\x08 extra');
    const head = concat(
      new Uint8Array([0x1f, 0x8b, 0x08, 0x04 | 0x08 | 0x10 | 0x02, 0, 0, 0, 0, 0, 0xff]),
      new Uint8Array([extra.byteLength & 0xff, extra.byteLength >> 8]), extra,
      encoder.encode('passage-all-checks.json'), new Uint8Array([0]),
      encoder.encode('a comment'), new Uint8Array([0]),
    );
    const headerCrc = crc32(head) & 0xffff;
    const flagged = concat(head, new Uint8Array([headerCrc & 0xff, headerCrc >> 8]), plain.slice(10));
    expect(await read(fileOf(flagged))).toEqual(await read(fileOf(plain)));
    expect((await read(fileOf(flagged))).items.at(-1)).toEqual({ trailer: { ok: true, checks: 1 } });
  });

  it('writes a member size modulo 2^32, so files past 4 GiB compare as gzip records them', async () => {
    expect(memberSizeBytes(5)).toEqual([5, 0, 0, 0]);
    expect(memberSizeBytes(0x01020304)).toEqual([4, 3, 2, 1]);
    expect(memberSizeBytes(2 ** 32 + 5)).toEqual([5, 0, 0, 0]);
    expect(memberSizeBytes(2 ** 32 - 1)).toEqual([255, 255, 255, 255]);
    expect(memberSizeBytes(2 ** 33)).toEqual([0, 0, 0, 0]);
    // injected sizes: the checks read the same past a multiple of 4 GiB
    const text = backup([fakeLine(40)]);
    const size = encoder.encode(text).byteLength;
    const one = fileOf(gzip(text));
    for (const inflated of [size, size + 2 ** 32, size + 2 ** 33]) expect(await endsWithSize(one, inflated)).toBe(true);
    expect(await endsWithSize(one, size + 1)).toBe(false);
    const two = fileOf(concat(gzip(text), gzip('x')));
    for (const inflated of [size, size + 2 ** 32]) expect(await holdsSecondMember(two, inflated)).toBe(true);
    expect(await holdsSecondMember(two, size + 1)).toBe(false);
    expect(await holdsSecondMember(one, size)).toBe(false);
  });

  it('says aborted for an abort during the second-member scan', async () => {
    const bytes = concat(gzip(backup([fakeLine(40)])), gzip('x'));
    const blob = new NodeBlob([bytes]);
    const controller = new AbortController();
    let streams = 0;
    const file = {
      size: bytes.byteLength,
      slice: (start, end) => blob.slice(start, end),
      stream() {
        streams += 1;
        if (streams === 1) return blob.stream();
        // the scan: the abort lands while it reads
        return new ReadableStream({ pull(stream) { controller.abort(); stream.enqueue(bytes.slice(0, 4)); } });
      },
    };
    const result = await read(file, { signal: controller.signal });
    expect(streams).toBe(2);
    expect(result.code).toBe(LINES.aborted);
  });

  it('says unreadable when the file\'s bytes cannot be read at its start or its end', async () => {
    const bytes = gzip(backup([fakeLine(40)]));
    const blob = new NodeBlob([bytes]);
    const failing = (at) => ({
      size: bytes.byteLength,
      slice: (start, end) => (start === at ? { arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotReadableError')) } : blob.slice(start, end)),
      stream: () => blob.stream(),
    });
    expect(await read(failing(0))).toMatchObject({ items: [], code: LINES.unreadable });
    const end = await read(failing(bytes.byteLength - 4));
    expect(end).toMatchObject({ items: [{ kind: 'v2', header }, fakeLine(40)], code: LINES.unreadable, detail: 'the end of the file could not be read' });
  });
});

describe('a version-3 file: a names line after the header', () => {
  const NAMES = [{ passage_id: 'p-1', name: 'Autumn delivery, Cherbourg → Plymouth' }, { passage_id: 'p-2', name: 'Île d’Yeu 🌊' }];
  const HEADER3 = checkFileHeaderLine({ exportedAt, exportedBy, version: 3 });
  const backup3 = (namesLine, lines, trailer = checkFileTrailerLine(lines.length)) => HEADER3 + namesLine + lines.map((line) => `${line}\n`).join('') + trailer;

  it('yields the header, the names, each check line and the trailer', async () => {
    const result = await read(fileOf(gzip(backup3(checkFileNamesLine(NAMES), [fakeLine(40), fakeLine(50)]))));
    expect(result).toEqual({ items: [{ kind: 'v3', header }, { names: NAMES }, fakeLine(40), fakeLine(50), { trailer: { ok: true, checks: 2 } }], code: null });
  });

  it('yields no names for an empty names line, and reads the same in chunks of one byte', async () => {
    const text = backup3(checkFileNamesLine([]), [fakeLine(40)]);
    const whole = await read(fileOf(gzip(text)));
    expect(whole.items.slice(0, 2)).toEqual([{ kind: 'v3', header }, { names: [] }]);
    expect(await readChunks(Array.from(encoder.encode(text), (byte) => new Uint8Array([byte])))).toEqual(whole);
  });

  it('stops before any check at a names line over its cap, and reads one at the cap', async () => {
    const line = checkFileNamesLine(NAMES);
    const size = encoder.encode(line).byteLength - 1;
    expect((await read(fileOf(gzip(backup3(line, [fakeLine(40)]))), { caps: { namesBytes: size } })).code).toBeNull();
    const over = await read(fileOf(gzip(backup3(line, [fakeLine(40)]))), { caps: { namesBytes: size - 1 } });
    expect(over).toEqual({ items: [{ kind: 'v3', header }], code: LINES.tooLarge, detail: 'a names line over its cap' });
  });

  it('refuses a file cut inside its names line as truncated, and one with nothing after its header', async () => {
    const text = backup3(checkFileNamesLine(NAMES), [fakeLine(40)]);
    expect(await read(fileOf(gzip(text.slice(0, HEADER3.length + 30))))).toEqual({ items: [{ kind: 'v3', header }], code: LINES.truncated, detail: 'no trailer' });
    expect(await read(fileOf(gzip(text.slice(0, HEADER3.length + 4))))).toMatchObject({ code: LINES.truncated });
    expect(await read(fileOf(gzip(HEADER3)))).toMatchObject({ items: [{ kind: 'v3', header }], code: LINES.truncated });
  });

  it('says the names are unreadable, and still reads the checks, for a refused names line or one that is not UTF-8', async () => {
    const refused = await read(fileOf(gzip(backup3('{"names":[{"passage_id":"a b","name":"x"}],"names_digest":"0123456789abcdef"}\n', [fakeLine(40)]))));
    expect(refused).toEqual({ items: [{ kind: 'v3', header }, { namesUnreadable: true }, fakeLine(40), { trailer: { ok: true, checks: 1 } }], code: null });
    const bad = concat(encoder.encode(HEADER3), encoder.encode('{"names":[{"passage_id":"a","name":"'), new Uint8Array([0xff, 0xfe]), encoder.encode('"}],"names_digest":"0123456789abcdef"}\n'),
      encoder.encode(`${fakeLine(40)}\n${checkFileTrailerLine(1)}`));
    expect(await read(fileOf(gzip(bad)))).toEqual({ items: [{ kind: 'v3', header }, { namesUnreadable: true }, fakeLine(40), { trailer: { ok: true, checks: 1 } }], code: null });
  });

  it('says the names are unreadable when the header is followed directly by a check line or the trailer, and reads that line as what it is', async () => {
    const direct = await read(fileOf(gzip(HEADER3 + `${fakeLine(40)}\n${checkFileTrailerLine(1)}`)));
    expect(direct).toEqual({ items: [{ kind: 'v3', header }, { namesUnreadable: true }, fakeLine(40), { trailer: { ok: true, checks: 1 } }], code: null });
    expect(await read(fileOf(gzip(HEADER3 + checkFileTrailerLine(0))))).toEqual({ items: [{ kind: 'v3', header }, { namesUnreadable: true }, { trailer: { ok: true, checks: 0 } }], code: null });
    // the trailer without its newline, right after the header
    expect(await read(fileOf(gzip(HEADER3 + checkFileTrailerLine(0).slice(0, -1))))).toEqual({ items: [{ kind: 'v3', header }, { namesUnreadable: true }, { trailer: { ok: true, checks: 0 } }], code: null });
    // a short line that is no names line
    expect((await read(fileOf(gzip(`${HEADER3}{}\n${checkFileTrailerLine(1)}`)))).items).toEqual([{ kind: 'v3', header }, { namesUnreadable: true }, '{}', { trailer: { ok: true, checks: 1 } }]);
  });

  it('yields a second names line later as a check line, for the caller to refuse', async () => {
    const names = checkFileNamesLine(NAMES);
    const result = await read(fileOf(gzip(backup3(names, [fakeLine(40), names.slice(0, -1)]))));
    expect(result.items).toEqual([{ kind: 'v3', header }, { names: NAMES }, fakeLine(40), names.slice(0, -1), { trailer: { ok: true, checks: 2 } }]);
  });

  it('keeps a version-2 file as it was: no names item', async () => {
    const result = await read(fileOf(gzip(backup([fakeLine(40)]))));
    expect(result.items).toEqual([{ kind: 'v2', header }, fakeLine(40), { trailer: { ok: true, checks: 1 } }]);
    expect(LINE_CAPS.namesBytes).toBe(512 * 1024);
  });
});
