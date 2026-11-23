// lazy tiles: buildWorld's plan pass reserves the exact same slot layout as a full build, fills
// only the focus tiles up front, and fillNext() reproduces every mesh/instance byte-for-byte.
// The browser-side wiring (static buffers, indirect draws, background pump) is source-checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { engine, openPack } from '../lib/worldharness.mjs';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const src = (f) => readFileSync(path.join(ROOT, 'source', f), 'utf8');
const E = await engine();
const P1 = await openPack('packs/grodno.mpk');
const P2 = await openPack('packs/grodno.mpk');
const full = await E.buildWorld(P1);
const lazy = await E.buildWorld(P2, { lazy: true, focus: [0, 0], count: 9 });
const hash = (m) => createHash('sha1').update(Buffer.from(m.vb)).update(Buffer.from(m.ib.buffer, m.ib.byteOffset, m.ib.byteLength)).digest('hex');

test('lazy: plan pass reserves the exact full-world slot layout', () => {
  assert.equal(lazy.lazy, true);
  assert.equal(lazy.meshes.length, full.meshes.length);
  assert.equal(lazy.types.length, full.types.length);
  assert.equal(lazy.nI, full.nI);
  assert.equal(lazy.labels.length, full.labels.length);
  assert.equal(lazy.bboxes.length, full.bboxes.length);
  let diff = 0; for (let i = 0; i < full.inst.byteLength; i++) if (full.inst[i] !== lazy.inst[i]) diff++;
  assert.equal(diff, 0, 'instance rows identical after the plan pass');
  assert.equal(lazy.filledCount(), 9, 'only the focus tiles are meshed up front');
  assert.ok(lazy.meshes.filter((m) => m.pending).length > 30000, 'the rest stay reserved-but-empty');
});

test('lazy: every mesh reserved for a focus tile is real, distant ones stay pending', () => {
  let filled = 0, pending = 0;
  for (const m of lazy.meshes) {
    if (m.pending) { pending++; assert.ok(m.nv >= 0 && m.ni >= 0, 'pending meshes still carry reserved counts'); }
    else { filled++; assert.ok(m.vb && m.ib, 'a filled mesh has geometry buffers'); }
  }
  assert.ok(filled > 0 && pending > 0);
});

test('lazy: fillNext completes all tiles with byte-identical geometry', () => {
  let n = 0;
  for (;;) { const got = lazy.fillNext(64, 1e9); n += got.length; if (!got.length) break; }
  assert.equal(n, P2.h.tiles.length - 9, 'every remaining tile filled');
  assert.equal(lazy.filledCount(), P2.h.tiles.length);
  assert.equal(lazy.meshes.filter((m) => m.pending).length, 0, 'no slot left empty');
  let bad = 0;
  for (let i = 0; i < full.meshes.length; i += 97) if (hash(full.meshes[i]) !== hash(lazy.meshes[i])) bad++;
  assert.equal(bad, 0, 'sampled meshes match the full build byte-for-byte');
  let diff = 0; for (let i = 0; i < full.inst.byteLength; i++) if (full.inst[i] !== lazy.inst[i]) diff++;
  assert.equal(diff, 0, 'refreshed instance rows still match');
});

test('lazy: browser wiring keeps static buffers and switches draws on as tiles land', () => {
  const w = src('src/world.js'), m = src('src/main.js'), math = src('src/math.js');
  assert.match(math, /if \(this\.dry\) return this\.nv\+\+/, 'dry builder counts vertices without geometry');
  assert.match(math, /if \(this\.dry\) \{ this\.ni \+= 3; return; \}/, 'dry builder counts triangles');
  assert.match(w, /if \(opts\.lazy\)/, 'lazy mode is opt-in at the world builder');
  assert.match(w, /slot = \{ t: r\.t0, i: r\.i0 \}/, 'fills write into pre-reserved slot ranges');
  assert.match(w, /dst\.vb = src\.vb; dst\.ib = src\.ib/, 'mesh objects are filled in place (slot identity preserved)');
  assert.match(m, /const LAZY = !POOL && \(QP\.has\('lazy'\) \|\| \(!AUTO && !QP\.has\('full'\)\)\)/, 'interactive sessions are lazy by default');
  assert.match(m, /if \(m\.pending\) continue;/, 'empty slots are not uploaded');
  assert.match(m, /s\.mesh\.pending \? 0 : s\.mesh\.ni/, 'pending indirect draws start at zero index count');
  assert.match(m, /Q\.writeBuffer\(bArgs\[0\], si \* 20, arg\)/, 'fills refresh their indirect draws');
  assert.match(m, /rebakeShadows\(\)/, 'baked shadows are refreshed once the queue drains');
});
