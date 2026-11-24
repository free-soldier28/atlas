// water mask: polygons + widened centreline ribbons in one grid index. The pipeline drops houses,
// elevates crossings and clips submerged road runs against it; QA must fail any pack that still
// ships a conflict. Pure-module tests + source contracts for the self-heal loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeMask, inWater, submerged, crossesBig } from '../lib/water-mask.mjs';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
// a 50 x 50 m lake at (100..150, 100..150) — above the 2000 m2 big-water gate and a river ribbon along z=300 (x 0..400)
const mask = makeMask(
  [{ pts: [100, 100, 150, 100, 150, 150, 100, 150], area: 2500 }],
  [{ pts: [0, 300, 400, 300], hw: 12 }]);

test('inWater: polygon interior, ribbon band and dry land', () => {
  assert.equal(inWater(mask, 120, 120), true, 'lake interior');
  assert.equal(inWater(mask, 120, 305), true, 'river ribbon');
  assert.equal(inWater(mask, 120, 320), false, 'outside the ribbon');
  assert.equal(inWater(mask, 200, 200), false, 'dry land');
  assert.equal(inWater(mask, 120, 100, 0.5), true, 'bank margin settles a boundary tie');
});

test('submerged: footprint fraction, not just a single vertex', () => {
  const house = [110, 110, 140, 110, 140, 140, 110, 140]; // fully in the lake
  const bank = [150, 110, 170, 110, 170, 130, 150, 130]; // only its edge touches the lake
  assert.ok(submerged(mask, house) >= 0.8, 'a house in the lake is nearly fully submerged');
  assert.ok(submerged(mask, bank) < 0.6, 'a house beside the lake stays');
});

test('crossesBig: a segment crossing water between dry endpoints is caught', () => {
  const road = [120, 80, 120, 90, 120, 160, 120, 200]; // crosses the lake, ends dry
  assert.equal(crossesBig(mask, road), true);
  const dryRoad = [200, 300, 200, 320]; // inside the 12 m river ribbon — a real crossing now
  assert.equal(crossesBig(mask, dryRoad), true, 'a 12 m river ribbon needs a bridge');
  const stream = makeMask([], [{ pts: [0, 300, 400, 300], hw: 2 }]); // 4 m stream
  assert.equal(crossesBig(stream, dryRoad.slice(0, 0).concat([200, 298, 200, 302])), false, 'a 4 m stream is step-over water');
  const alongBank = [100, 90, 150, 90];
  assert.equal(crossesBig(mask, alongBank), false);
});

test('QA errors carry fix metadata and build-city self-heals before failing', () => {
  const qa = readFileSync(path.join(ROOT, 'pipeline', 'qa.mjs'), 'utf8');
  assert.ok(/fix: wetFix/.test(qa), 'water conflicts must carry the offending record location');
  assert.ok(/fix: \[\{ tile: r.tile/.test(qa), 'bridge conflicts must be locatable');
  const build = readFileSync(path.join(ROOT, 'pipeline', 'build-city.mjs'), 'utf8');
  assert.match(build, /const emitPack = \(\) =>/, 'emit must be repeatable');
  assert.match(build, /for \(let pass = 0; pass < 4; pass\+\+\)/, 'QA self-heal loop present');
  assert.match(build, /emitPack\(\);\n\s*console\.log\(`build: QA self-heal/, 'a fix re-emits the pack');
});
