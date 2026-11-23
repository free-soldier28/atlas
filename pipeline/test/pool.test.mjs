// Phase B tile pool: fixed-capacity slots, camera-follow load/unload, byte-stable reloads.
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
const P = await openPack('packs/grodno.mpk');
const W = await E.buildWorld(P, { pool: 8, focus: [0, 0] });
const order = W.nearest(P.h.tiles.map((_, i) => i), 0, 0);
const hash = (m) => createHash('sha1').update(Buffer.from(m.vb)).update(Buffer.from(m.ib.buffer, m.ib.byteOffset, m.ib.byteLength)).digest('hex');

test('pool: fixed footprint, ground survives the context swap', () => {
  assert.equal(W.pool.size, 8);
  assert.equal(W.meshes.length, 8 * W.pool.capM + 2); // slot meshes + shared empty LOD + ground
  assert.equal(W.types.length, 8 * W.pool.capT + 2); // slot types + null + ground (+ marker in the browser)
  assert.ok(W.pool.capV > 100000 && W.pool.capX > 150000, 'budgets cover the largest pack tile');
  assert.ok(W.meshes.some((m) => !m.pending && m.ni === 6), 'the pack ground plane is present');
  assert.equal(W.pool.loaded(), 0);
});

test('pool: load fills a slot, unload blanks its instances and meshes', () => {
  const r = W.pool.load(0, order[0]);
  assert.equal(r.tile, order[0]);
  assert.ok(r.meshes.length > 20, 'a real tile has many meshes');
  assert.ok(r.meshes.every((m) => !m.pending && m.vb && m.ib));
  assert.equal(r.meshes.reduce((n, m) => n + m.nv, 0) <= W.pool.capV, true, 'vertex budget respected');
  assert.equal(r.meshes.reduce((n, m) => n + m.ni, 0) <= W.pool.capX, true, 'index budget respected');
  assert.equal(W.pool.loaded(), 1);
  const u = W.pool.unload(0);
  assert.equal(W.pool.loaded(), 0);
  assert.ok(u.meshes.every((m) => m.pending && m.ni === 0));
  const iu = new Uint32Array(W.pool.inst, u.i0 * 48, W.pool.capI * 12);
  for (let k = 0; k < W.pool.capI; k++) assert.equal(iu[k * 12 + 9], W.pool.nullTy, 'unloaded instances point at the null type → cull emits nothing');
});

test('pool: reloading a tile is byte-identical and arrays never grow', () => {
  const beforeMeshes = W.meshes.length, beforeTypes = W.types.length, beforeInst = W.pool.inst.byteLength;
  const first = W.pool.load(1, order[3]).meshes.map(hash);
  W.pool.load(1, order[4]);
  W.pool.unload(1);
  const again = W.pool.load(1, order[3]).meshes.map(hash);
  assert.deepEqual(again, first, 'same tile → same geometry after eviction and reload');
  assert.equal(W.meshes.length, beforeMeshes);
  assert.equal(W.types.length, beforeTypes);
  assert.equal(W.pool.inst.byteLength, beforeInst);
});

test('pool: browser wiring rewrites type records, indirect draws and instances', () => {
  const m = src('src/main.js'), w = src('src/world.js');
  assert.match(w, /opts\.pool/, 'pool mode is opt-in at buildWorld');
  assert.match(w, /bundle = true; tile\(i, T\); bundle = false/, 'a tile is built into its own bundle');
  assert.match(w, /poolIU\[o \+ 9\] = sT \+ B\.IU\[/, 'bundle type indices are rebased into the slot');
  assert.match(w, /poolIU\[o \+ 9\] = nullTy/, 'unused instances are nulled');
  assert.match(m, /const POOL = QP\.has\('pool'\)/, '?pool=N enables streaming');
  assert.match(m, /const si = tU\[l\]; \/\/ the slot index/, 'draws are refreshed by type slot index, not by mesh identity');
  assert.match(m, /Q\.writeBuffer\(bTypes, idx \* 48, tBuf\)/, 'MType records are rewritten on load');
  assert.match(m, /setInterval\(sync, 750\)/, 'camera-follow tick runs continuously');
});
