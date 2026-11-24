// startup fast paths: (1) no geolocation request until the user asks, (2) both sky/env
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

test('startup: no automatic geolocation request — only the locate button / G asks', () => {
  const m = src('main.js');
  assert.doesNotMatch(m, /const fixP = geoFix\(\)/, 'no fix request may fire at startup');
  assert.doesNotMatch(m, /fixP\.then/, 'the start camera must not jump to a late fix');
  assert.match(m, /const geoFix = \(\)/, 'the fix helper stays for explicit requests');
  assert.match(m, /\$\('lc'\)\.onclick = \(\) => locate\(\)/, 'the locate button still works');
  const camera = m.indexOf('lookAt(...POSES[0]);', m.indexOf('start camera:'));
  assert.ok(camera > 0 && m.indexOf('await skyDay; await skyNight;') > camera, 'the pack viewpoint opens the scene');
  const gps = src('gps.js');
  assert.match(gps, /const gpsStart = \(\) => \{[\s\S]*?else gpsLabel\(\);/, 'GPS defaults to Off, not a live watch');
});

test('startup: ?cam=x,y,z,tx,ty,tz jumps to a location from a link', () => {
  const m = src('main.js');
  assert.match(m, /QP\.get\('cam'\)/, 'camera query parameter');
  assert.match(m, /c\.length === 6 && c\.every\(Number\.isFinite\)/, 'invalid values are ignored');
  const at = m.indexOf("QP.get('cam')"), look = m.indexOf('lookAt(...POSES[0]);');
  assert.ok(at > look && at < m.indexOf('startStream();'), 'override applies before the stream follows the camera');
});

test('startup: tiles inflated in parallel batches, every tile still reaches the world', async () => {
  const w = src('world.js');
  assert.match(w, /const TB = 24;/, 'batched prefetch width');
  assert.match(w, /const inflate = \(inds\) => Promise\.all\(/, 'prefetch uses Promise.all over a batch');
  assert.match(w, /incoming = inflate\(inds\.slice\(k \+ 1/, 'next batch starts while the current one is meshed');
  const P = await openPack('packs/grodno.mpk');
  P.tiles.clear(); // force the cold path: all inflation happens through the prefetch batches
  const W = await (await engine()).buildWorld(P);
  assert.equal(P.tiles.size, P.h.tiles.length, `all ${P.h.tiles.length} tiles must be inflated`);
  assert.ok(W.labels.length > 20000, 'labels from every tile present');
  assert.ok(W.nI > 14000, 'instances from every tile present');
});
