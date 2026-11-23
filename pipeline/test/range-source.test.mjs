// Range source: header-first reads over a mock HTTP server, fallback when Range is ignored,
// and a full pack decode through P.read (same tiles/graph as the embedded-byte path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { engine, openRange } from '../lib/worldharness.mjs';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const bytes = readFileSync(path.join(ROOT, 'packs/grodno.mpk'));
const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// a fetch stub that behaves like GitHub Pages: Range → 206 + content-range + Accept-Ranges
const rangedFetch = (track = []) => async (url, o = {}) => {
  const h = o.headers?.Range || '';
  track.push(h);
  const parse = /^bytes=(\d+)-(\d+)$/.exec(h);
  const a = parse ? +parse[1] : 0, b = parse ? Math.min(+parse[2], u8.byteLength - 1) : u8.byteLength - 1;
  return {
    status: parse ? 206 : 200, ok: true,
    headers: { get: (k) => k.toLowerCase() === 'content-range' ? `bytes ${a}-${b}/${u8.byteLength}` : null },
    arrayBuffer: async () => u8.subarray(a, b + 1).slice().buffer,
  };
};
const plainFetch = (track = []) => async (url, o = {}) => {
  track.push(o.headers?.Range || '');
  return { status: 200, ok: true, headers: { get: () => null }, arrayBuffer: async () => u8.slice().buffer };
};

test('range: header first, tile slices on demand, repeated reads coalesce', async () => {
  const seen = [], src = await openRange('http://x/p.mpk', rangedFetch(seen));
  assert.equal(src.ranged, true);
  assert.equal(src.total, u8.byteLength);
  assert.equal(new DataView(src.u8.buffer).getUint32(0, true), 0x314b504d);
  assert.ok(src.u8.byteLength >= 8 + new DataView(src.u8.buffer).getUint32(4, true));
  assert.equal(seen.length, 1, 'one request for the header');
  const [x, z, off, len] = [0, 0, 100000, 512];
  const a = await src.read(off, len), b = await src.read(off, len);
  assert.equal(a.byteLength, len);
  assert.deepEqual(Array.from(a.slice(0, 8)), Array.from(u8.subarray(off, off + 8)));
  assert.equal(seen.length, 2, 'two identical reads share one network request');
  assert.deepEqual(Array.from(b), Array.from(a), 'cached block serves both reads');
});

test('range: a server that ignores Range falls back to the full file', async () => {
  const seen = [], src = await openRange('http://x/p.mpk', plainFetch(seen));
  assert.equal(src.ranged, false);
  assert.equal(src.u8.byteLength, u8.byteLength);
  const part = await src.read(200, 64);
  assert.deepEqual(Array.from(part), Array.from(u8.subarray(200, 264)));
  assert.equal(seen[0], 'bytes=0-131071', 'the header attempt was made first');
  const seen2 = [], forced = await openRange('http://x/p.mpk', plainFetch(seen2), { forceFull: true });
  assert.equal(forced.ranged, false);
  assert.equal(seen2[0], '', '?norange skips the header probe');
});

test('range: embedded pack bytes never touch the network', async () => {
  const src = await openRange('file:///p.mpk', async () => { throw new Error('fetch called'); }, { bytes: u8 });
  assert.equal(src.ranged, false);
  assert.deepEqual(Array.from(await src.read(10, 5)), Array.from(u8.subarray(10, 15)));
});

test('range: loader prefers the range source and keeps an in-memory fallback', () => {
  const src = (f) => readFileSync(path.join(ROOT, 'source', f), 'utf8');
  const l = src('src/loader.js'), f = src('src/format.js'), b = src('build.mjs');
  assert.match(l, /await openRange\(u, fetch, \{ forceFull: QP\.has\('norange'\) \}\)/);
  assert.match(l, /PK\.read = src\.read/);
  assert.match(f, /P\.read \? await P\.read\(off, len\) : P\.u8\.subarray/);
  assert.match(b, /'format\.js', 'range\.js', 'loader\.js'/);
});

test('range: mpkTile and mpkGraph decode identically through the range source', async () => {
  const E = await engine();
  const src = await openRange('http://x/p.mpk', rangedFetch());
  const P = E.mpkOpen(src.u8);
  P.read = src.read;
  const plain = E.mpkOpen(u8);
  for (const i of [0, 17, 479, 979]) {
    const a = await E.mpkTile(P, i), b = await E.mpkTile(plain, i);
    assert.equal(JSON.stringify(a.lods.map((l) => l.map((L) => [L.kind, L.recs.length]))),
      JSON.stringify(b.lods.map((l) => l.map((L) => [L.kind, L.recs.length]))), `tile ${i} layer counts match`);
    const ba = a.lods.flat().find((L) => L.kind === 1), bb = b.lods.flat().find((L) => L.kind === 1);
    if (ba && bb) assert.deepEqual(Array.from(ba.recs[0].pts.slice(0, 8)),
      Array.from(bb.recs[0].pts.slice(0, 8)), `tile ${i} geometry matches`);
  }
  const g = await E.mpkGraph(P);
  assert.equal(g.ea.length, (await E.mpkGraph(plain)).ea.length, 'graph decoded from a range read');
  assert.match(src.read.toString(), /fetchFn|grab/, 'source carries a read function');
});
