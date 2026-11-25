// pedestrian crossings: OSM tags footways with crossing=*, the pipeline turns those into header
// records where they meet a road, and the renderer paints zebra bars. Pure lib + source contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collectCrossings } from '../lib/crossings.mjs';
import { openPack, readCache, hasCache } from './helpers.mjs';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');

test('collectCrossings: centre crossing keeps road heading, width and kind', () => {
  const road = [{ pts: [-100, 0, 100, 0], cls: 2, width: 12 }];
  const foot = [{ pts: [0, -20, 0, 20], crossing: 'zebra' }];
  const out = collectCrossings(foot, road);
  assert.equal(out.length, 1, 'one crossing at the intersection');
  assert.ok(Math.abs(out[0].x) < 0.01 && Math.abs(out[0].z) < 0.01);
  assert.ok(Math.abs(Math.sin(out[0].a)) < 0.01, 'bars span the road across the footway');
  assert.equal(out[0].w, 12);
  assert.equal(out[0].k, 0);
});

test('collectCrossings: a footway ending at the kerb is snapped to the road', () => {
  const road = [{ pts: [-100, 0, 100, 0], cls: 5, width: 8 }];
  const foot = [{ pts: [0, -20, 0, -1], crossing: 'traffic_signals' }];
  const out = collectCrossings(foot, road);
  assert.equal(out.length, 1, 'the endpoint still marks a crossing');
  assert.equal(out[0].k, 1);
});

test('collectCrossings: a +z road keeps a π/2 heading (bars span the road, not along it)', () => {
  const road = [{ pts: [0, -100, 0, 100], cls: 2, width: 10 }];
  const foot = [{ pts: [-20, 0, 20, 0], crossing: 'zebra' }];
  const out = collectCrossings(foot, road);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].a - Math.PI / 2) < 0.01, 'road tangent, not footway tangent');
});

test('collectCrossings: a perpendicular road wins over a closer parallel one', () => {
  const roads = [
    { pts: [0, -100, 0, 100], cls: 2, width: 12 },   // footway runs ALONG this road: wrong crossing
    { pts: [-100, -6, 100, -6], cls: 5, width: 8 },  // footway ends at it at 90°: correct
  ];
  const foot = [{ pts: [0, -20, 0, -5], crossing: 'zebra' }];
  const out = collectCrossings(foot, roads);
  assert.equal(out.length, 1, 'one crossing per tagged way');
  assert.ok(Math.abs(Math.sin(out[0].a)) < 0.01, 'horizontal road heading (mod π)');
});

test('collectCrossings: a footway crossing two roads still produces one zebra', () => {
  const roads = [{ pts: [-100, -10, 100, -10], cls: 4, width: 10 }, { pts: [-100, 10, 100, 10], cls: 4, width: 10 }];
  assert.equal(collectCrossings([{ pts: [0, -20, 0, 20], crossing: 'zebra' }], roads).length, 1);
});

test('collectCrossings: a junction zebra spans all parallel carriageways', () => {
  const roads = [
    { pts: [-100, 0, 100, 0], cls: 4, width: 10, osmId: 1 },
    { pts: [-100, 12, 100, 12], cls: 4, width: 10, osmId: 2 },
    { pts: [0, -100, 0, 100], cls: 4, width: 10, osmId: 3 }, // perpendicular leg
  ];
  const out = collectCrossings([{ pts: [0, -20, 0, 20], crossing: 'zebra' }], roads);
  assert.equal(out.length, 1);
  assert.ok(out[0].w > 20, `zebra width ${out[0].w} covers both parallel roads, not a lone patch`);
});

test('collectCrossings: a footway running along the only nearby road gets no zebra', () => {
  const roads = [{ pts: [-100, 0, 100, 0], cls: 5, width: 8, osmId: 1, nodeIds: [1, 2] }];
  const foot = [{ pts: [0, -3, 40, -3], crossing: 'unmarked', nodeIds: [10, 11] }];
  assert.equal(collectCrossings(foot, roads).length, 0, 'parallel is not a crossing');
});

test('collectCrossings: crossing=no and far-away ways are ignored', () => {
  const road = [{ pts: [-100, 0, 100, 0], cls: 5, width: 8 }];
  assert.equal(collectCrossings([{ pts: [0, -20, 0, 20], crossing: 'no' }], road).length, 0);
  assert.equal(collectCrossings([{ pts: [0, -200, 0, -180], crossing: 'yes' }], road).length, 0);
});

test('pack ships real crossings and the renderer paints them', async () => {
  const P = await openPack();
  const cs = P.h.crossings;
  assert.ok(cs && cs.length > 50, `expected hundreds of mapped crossings, got ${cs?.length || 0}`);
  assert.ok(cs.every((c) => Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(c.a) && c.w > 0));
  const src = readFileSync(path.join(ROOT, 'source', 'src', 'world.js'), 'utf8');
  assert.match(src, /PK\.h\.crossings/, 'world reads the header list');
  assert.match(src, /mb\.quad\(a, b, d, e\)/, 'zebra bars are real geometry');
  assert.match(src, /cx = c\.x \+ nx \* o, cz = c\.z \+ nz \* o/, 'bars repeat across the road');
  assert.match(src, /cx - ux \* half, 0\.095, cz - uz \* half/, 'each bar runs along the road');
  const cache = hasCache('roads') ? readCache('roads').filter((e) => e.tags?.crossing && e.tags.crossing !== 'no') : null;
  if (cache) assert.ok(cache.length > 100, 'the OSM cache really contains crossing tags');
});
