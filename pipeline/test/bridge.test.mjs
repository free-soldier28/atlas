// bridges: the "road lies in the water" defect. The pipeline flags every way crossing big water
// (tagged or auto-detected) and bakes per-vertex deck heights; the renderer reads them into an
// elevated ribbon plus structure. Covered here: crossing detection (banks don't count), the deck
// profile (ramps end at the road base, short spans never overtop), ys slicing across clipped
// runs, the pack roundtrip, and the elevated deck reaching buildWorld's meshes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossesWater, deckHeights, ysAt } from '../lib/bridge.mjs';
import { engine } from '../lib/worldharness.mjs';
import { MPKBuilder } from '../lib/pack.mjs';

const CM = 100;

test('crossesWater: real crossings flagged, bank-running ways not', () => {
  // a river poly: a 60 x 200 m band, 3000 m²
  const river = { pts: [0, 0, 60, 0, 60, 200, 0, 200], area: 12000 };
  const across = [30, -40, 30, 60, 30, 120, 30, 240].map((v) => v); // straight through
  assert.equal(crossesWater(across, [river]), true, 'a way through the river must cross');
  const alongBank = [-20, 10, -20, 80, -20, 150]; // outside, parallel
  assert.equal(crossesWater(alongBank, [river]), false, 'a way beside the river must not cross');
  const onBank = [0, 20, 0, 90, 0, 160]; // exactly ON the west edge, no inward step
  assert.equal(crossesWater(onBank, [river]), false, 'bank-touching must not count');
  const dipsIn = [40, -30, 40, 40, 80, 140]; // nose in, comes back out the same edge? no: exits east
  assert.equal(crossesWater(dipsIn, [river]), true, 'enter-and-exit must count');
  const endsInside = [30, 50, 45, 90, 55, 130]; // dies mid-river (ferry ramp data)
  assert.equal(crossesWater(endsInside, [river]), true, 'a way ending inside water must count');
  // small ponds under the threshold are data noise, not bridge sites
  const pond = { pts: [10, 10, 30, 10, 30, 30, 10, 30], area: 400 };
  const overPond = [20, 0, 20, 40];
  assert.equal(crossesWater(overPond, [pond]), false, 'a 400 m² pond is not bridge-worthy');
});

test('deckHeights: ramps land on the road base, middle is flat deck, short spans stay sane', () => {
  const flat = [0, 0, 40, 0, 80, 0, 120, 0, 160, 0, 200, 0]; // 200 m, metres
  const ys = deckHeights(flat, 5);
  assert.equal(ys[0], 6, 'ramp start sits on the road base (6 cm)');
  assert.equal(ys[ys.length - 1], 6, 'ramp end sits on the road base');
  assert.equal(Math.max(...ys), 500, 'middle reaches the full 5 m deck');
  for (let i = 1; i < ys.length / 2; i++) assert.ok(ys[i] >= ys[i - 1] - 1, 'rise phase must be monotone');
  // monotone down towards the end too
  for (let i = ys.length / 2; i + 1 < ys.length; i++) assert.ok(ys[i] >= ys[i + 1] - 1, 'fall phase must be monotone');
  const short = [0, 0, 10, 0, 20, 0]; // 20 m stream footbridge: ramp shrinks with the span
  const ys2 = deckHeights(short, 3);
  assert.ok(Math.max(...ys2) <= 300, 'never above its 3 m cap');
  assert.equal(ys2[0], 6);
  assert.equal(ys2[2], 6);
  assert.ok(Math.max(...ys2) > 50, 'but still clears the water');
  const degenerate = deckHeights([5, 5, 5, 5], 5); // zero length
  assert.deepEqual(degenerate, [6, 6]);
});

test('ysAt: fractional indices interpolate between source vertices (clip boundaries)', () => {
  const ys = [6, 106, 206, 306];
  assert.equal(ysAt(ys, 0), 6);
  assert.equal(ysAt(ys, 2), 206);
  assert.equal(ysAt(ys, 0.5), 56, 'halfway between vertices 0 and 1');
  assert.equal(ysAt(ys, 3.7), 306, 'past the last vertex clamps to it');
  assert.equal(ysAt(ys, -1), 6, 'before the first vertex clamps to it');
});

test('buildWorld: a bridge road renders an elevated deck with structure, a plain road does not', async () => {
  const E = await engine();
  // tile (0,0): a 12 m road east-west across a 3000 m² river poly, bridge-flagged with deck ys;
  // pts tile-local cm: x from 40 m to 260 m, deck 5 m mid-river with ramps baked per vertex
  const n = 12, pts = [], ys = [];
  for (let i = 0; i < n; i++) { const x = 40 + i * 20; pts.push(x * CM, 100 * CM); }
  for (let i = 0; i < n; i++) { const t = Math.min(Math.min(i, n - 1 - i) * 20 / 30, 1); ys.push(Math.round(6 + 494 * t * t * (3 - 2 * t))); }
  const river = [40 * CM, 40 * CM, 260 * CM, 40 * CM, 260 * CM, 160 * CM, 40 * CM, 160 * CM]; // 220 x 120 m
  const B = new MPKBuilder({ id: 'bridge-test', name: 'bridge-test', attribution: 'test', origin: [54, 28], tileSize: 512, bbox: [53.99, 27.98, 54.01, 28.01] });
  B.tile(0, 0, [[
    { kind: 3, recs: [{ kind: 0, pts: river }] },
    { kind: 2, recs: [{ cls: 2, flags: 2, name: '', lanes: 2, w10: 120, pts, ys }] },
  ]]);
  const P = E.mpkOpen(new Uint8Array(B.finish()));
  const W = await E.buildWorld(P);
  const asphalt = W.meshes.filter((m) => new Uint8Array(m.vb)[16] === E.M.ASPHALT);
  assert.ok(asphalt.length, 'deck ribbon mesh exists');
  // the deck ribbon: deck vertices mid-river at ~5 m, ramp ends at the road base
  const deckTop = Math.max(...asphalt.flatMap((m) => Array.from(new Float32Array(m.vb)).filter((v, k) => k % 5 === 1)));
  const deckEnd = Array.from(new Float32Array(asphalt[0].vb)).filter((v, k) => k % 5 === 1)[0];
  assert.ok(deckTop > 4.4, `mid-river deck must be ~5 m, got ${deckTop.toFixed(2)}`);
  assert.ok(deckEnd < 0.2, `ramp ends sit on the road base, got ${deckEnd.toFixed(2)}`);
  // structure: QUAY-mesh concrete (walls, parapets, piers) exists and tops out ~1.1 m above deck
  const quay = W.meshes.filter((m) => new Uint8Array(m.vb)[16] === E.M.QUAY);
  assert.ok(quay.length, 'bridge structure mesh exists');
  const qTop = Math.max(...quay.flatMap((m) => Array.from(new Float32Array(m.vb)).filter((v, k) => k % 5 === 1)));
  assert.ok(qTop > 5.5, `parapets must reach ~6.1 m over the 5 m deck, got ${qTop.toFixed(2)}`);
  const qBottom = Math.min(...quay.flatMap((m) => Array.from(new Float32Array(m.vb)).filter((v, k) => k % 5 === 1)));
  assert.ok(qBottom < 0.3, `piers/walls must reach the ground, got ${qBottom.toFixed(2)}`);
  // control: the same road without the bridge flag stays at the road base everywhere
  const B2 = new MPKBuilder({ id: 'flat-test', name: 'flat-test', attribution: 'test', origin: [54, 28], tileSize: 512, bbox: [53.99, 27.98, 54.01, 28.01] });
  B2.tile(0, 0, [[{ kind: 2, recs: [{ cls: 2, flags: 0, name: '', lanes: 2, w10: 120, pts }] }]]);
  const W2 = await E.buildWorld(E.mpkOpen(new Uint8Array(B2.finish())));
  const flat2 = W2.meshes.filter((m) => new Uint8Array(m.vb)[16] === E.M.ASPHALT);
  const flatTop = Math.max(...flat2.flatMap((m) => Array.from(new Float32Array(m.vb)).filter((v, k) => k % 5 === 1)));
  assert.ok(flatTop < 0.2, `a plain road must stay on the ground, got ${flatTop.toFixed(2)}`);
});
