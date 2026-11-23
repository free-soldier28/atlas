// shadow memory: one baked set shared by day/night, smaller maps on mobile/Low, and a one-time
// full-pack silhouette proxy for the far maps while the streaming pool only holds a few tiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { engine, openPack } from '../lib/worldharness.mjs';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const src = (f) => readFileSync(path.join(ROOT, 'source', f), 'utf8');
const main = src('src/main.js'), quality = src('src/quality.js'), world = src('src/world.js');

test('shadows: day and night share one baked set instead of two', () => {
  assert.match(main, /const tShN = tSh;/, 'night reuses the day textures');
  const allocations = (main.match(/tex\(SHN\[1\], SHN\[1\]/g) || []).length;
  assert.equal(allocations, 1, 'only one city/shelf/far set is allocated');
  assert.doesNotMatch(main, /shReady\[/, 'no per-profile readiness state left');
  assert.match(main, /await bakeShadowMaps\(tSh\); \/\/ one shared set: every profile switch re-bakes for its sun/);
  assert.match(main, /rebakeShadows = \(\) => \{ bakeShadowMaps\(tSh\); \};/);
});

test('shadows: mobile and Low use a quarter of the baked texels', () => {
  assert.match(quality, /mob \? \[1024, 2048, 1024, 512\] : \[1024, 4096, 2048, 1024\], \[0, 2048, 1024, 512\]/);
  const lowBakedMB = (2048 * 2048 + 1024 * 1024 + 512 * 512) * 2 / 1048576;
  const highBakedMB = (8192 * 8192 + 4096 * 4096 + 2048 * 2048) * 2 / 1048576;
  assert.ok(lowBakedMB < 11, `Low baked set is ${lowBakedMB.toFixed(1)} MB`);
  assert.ok(highBakedMB < 180, `High set is ${highBakedMB.toFixed(0)} MB (was double with night copies)`);
});

test('shadows: far maps use a one-time coarse proxy of the whole pack', async () => {
  assert.match(world, /for \(const L of T\.lods\.flat\(\)\) if \(L\.kind === 1\)/, 'proxy walks every tile layer');
  assert.match(world, /const buildShadowProxy = \(\) =>/, 'proxy built from plan data');
  assert.match(main, /await castProxy\(dst\[2\], 1400\)/, 'shelf map from proxy');
  assert.match(main, /await castProxy\(dst\[3\], 6800\)/, 'far map from proxy');
  assert.match(main, /const pShFarProxy = shPipe\(DFAR, 'none'\)/, 'proxy pipeline has no winding assumption');
  assert.match(main, /if \(Wd\.buildShadowProxy\)/, 'proxy built before the first bake in every mode');
  assert.match(world, /planTileData = tileData/, 'plan pass feeds the proxy');
  const E = await engine(), P = await openPack('packs/grodno.mpk');
  const W = await E.buildWorld(P); // default (non-pool) world: the proxy must be available too
  const mesh = W.buildShadowProxy();
  assert.ok(mesh.ni / 3 > 100000, `proxy has ${(mesh.ni / 3) | 0} triangles of full-city silhouettes`);
  assert.equal(mesh.pending, undefined, 'proxy geometry is real, not a counting stub');
});
