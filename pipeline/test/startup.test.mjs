// startup fast paths: (1) geolocation starts early and never gates __ready, (2) both sky/env
// profiles are submitted before the pack load with one GPU sync each, (3) tile inflation is
// batched and overlaps meshing. Source-order assertions break if a future edit puts a blocking
// await back on the critical path; the world test verifies no tile is skipped by the batching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { engine, openPack } from '../lib/worldharness.mjs';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const src = (f) => readFileSync(path.join(ROOT, 'source', 'src', f), 'utf8');

test('startup: sky/env submitted before the pack load, single sync per profile', () => {
  const m = src('main.js');
  const start = m.indexOf('const skyDay = bakeSkyEnv('), load = m.indexOf('await loadPack()');
  assert.ok(start > 0 && load > start, 'sky bakes must be submitted before loadPack()');
  const night = m.indexOf('const skyNight = bakeSkyEnv(');
  assert.ok(night > start && night < load, 'night profile must also start early');
  assert.ok(!/await flush\(/.test(m), 'per-pass GPU waits in the sky bake must stay collapsed');
  const ready = m.indexOf('window.__ready = true');
  assert.ok(m.indexOf('await skyDay; await skyNight;') < m.indexOf('render(); await Q.onSubmittedWorkDone();'),
    'the sky promises are awaited before the first render, never inside the critical path');
  assert.ok(m.indexOf('render(); await Q.onSubmittedWorkDone();') < ready, 'first render still precedes __ready');
});

test('startup: geolocation is fired early and only moves the camera after readiness', () => {
  const m = src('main.js');
  const geo = m.indexOf('const fixP = geoFix();');
  assert.ok(geo > 0, 'the fix request must be started once, early');
  assert.ok(!/const fix = await geoFix\(\)/.test(m), 'the old blocking await must be gone');
  const camera = m.indexOf('lookAt(...POSES[0]);', m.indexOf('start camera:'));
  assert.ok(camera > geo && m.indexOf('fixP.then(', camera) > camera, 'fix applied asynchronously after the pack viewpoint');
  assert.ok(m.indexOf('await skyDay; await skyNight;') > camera, 'geolocation never gates the first frame');
});

test('startup: tiles inflated in parallel batches, every tile still reaches the world', async () => {
  const w = src('world.js');
  assert.match(w, /const TB = 24;/, 'batched prefetch width');
  assert.match(w, /const prefetch = \(b\) => Promise\.all\(/, 'prefetch uses Promise.all over a batch');
  assert.match(w, /incoming = prefetch\(i \+ 1\)/, 'next batch starts while the current one is meshed');
  const P = await openPack('packs/grodno.mpk');
  P.tiles.clear(); // force the cold path: all inflation happens through the prefetch batches
  const W = await (await engine()).buildWorld(P);
  assert.equal(P.tiles.size, P.h.tiles.length, `all ${P.h.tiles.length} tiles must be inflated`);
  assert.ok(W.labels.length > 20000, 'labels from every tile present');
  assert.ok(W.nI > 14000, 'instances from every tile present');
});
