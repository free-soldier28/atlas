// trees + parks: green zones from the pack get their own ground tint and canopy pattern, and
// park/forest polygons scatter low-poly trees. Contracts cover the data, the meshes and the shader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { engine, openPack } from '../lib/worldharness.mjs';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const src = (f) => readFileSync(path.join(ROOT, 'source', 'src', f), 'utf8');

test('green zones are painted with their kind in LANDMAP alpha', async () => {
  const E = await engine();
  const P = await openPack('packs/grodno.mpk');
  const W = await E.buildWorld(P);
  let painted = 0, kinds = new Set();
  for (let k = 3; k < W.LANDMAP.length; k += 4) {
    if (W.LANDMAP[k] < 255) { painted++; kinds.add(W.LANDMAP[k]); }
  }
  assert.ok(painted > 1000, `expected painted green pixels, got ${painted}`);
  assert.ok(kinds.has(1) && kinds.has(2), `park and forest kinds expected, got ${[...kinds]}`);
});

test('buildWorld emits trunk and foliage meshes from park/forest polygons', async () => {
  const E = await engine();
  const P = await openPack('packs/grodno.mpk');
  const W = await E.buildWorld(P);
  const byMat = new Map();
  for (const m of W.meshes) {
    const mat = new Uint8Array(m.vb)[16];
    const e = byMat.get(mat) || { meshes: 0, verts: 0 };
    e.meshes++; e.verts += m.nv; byMat.set(mat, e);
  }
  assert.ok((byMat.get(E.M.LEAF)?.meshes || 0) > 10, 'foliage meshes exist');
  assert.ok((byMat.get(7)?.meshes || 0) > 10, 'trunk meshes exist');
  assert.ok((byMat.get(E.M.LEAF)?.verts || 0) < 2e6, 'tree geometry stays within a sane budget');
});

test('ground shader reads the green mask and the LEAF material branch exists', () => {
  const scene = src('sh_scene.js');
  assert.match(scene, /LEAF: 19/, 'foliage material id');
  assert.match(scene, /mat == 19u/, 'foliage shading branch');
  assert.match(scene, /textureSampleGrad\(tLand/, 'ground reads the land mask');
  assert.match(scene, /woods = 1\. - ss/, 'forest canopy pattern');
  const world = src('world.js');
  assert.match(world, /scatterTrees/, 'procedural scattering used');
  assert.match(world, /r\.kind <= 1|kind > 1/, 'only parks and forests get trees');
  const main = src('main.js');
  assert.match(main, /requiredLimits: \{ maxBufferSize/, 'device requests headroom for the bigger mesh');
});
