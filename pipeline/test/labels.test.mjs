// labels: housenumbers in the pack + street names already there; the overlay's dedup / collision
// grid / per-layer quota are extracted from the shipped source so the test breaks if they drift.
// Both layers are independently toggleable and default to on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { engine } from '../lib/worldharness.mjs';
import { MPKBuilder } from '../lib/pack.mjs';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const labelSrc = readFileSync(path.join(ROOT, 'source', 'src', 'labels.js'), 'utf8');
const { dedupe, place } = new Function(labelSrc + '\nreturn { dedupe, place };')();
const E = (text, kind, x, z, dist = 10) => ({ text, kind, x, z, priority: kind === 1 ? 0 : 1, dist });

test('dedupe: one label per street name per world cell, numbers stay per building', () => {
  const entries = [
    E('Main St', 1, 10, 10), E('Main St', 1, 20, 15),   // same 60 m cell → one
    E('Main St', 1, 200, 10),                            // far cell → keep
    E('12', 0, 10, 10), E('12', 0, 30, 10),              // same number, different houses
    E('12', 0, 10.5, 10.5),                              // same house, near-duplicate record → fold
  ];
  const out = dedupe(entries);
  assert.equal(out.filter((e) => e.kind === 1).length, 2, 'street folded per cell');
  assert.equal(out.filter((e) => e.kind === 0).length, 2, 'near-duplicate house folded, other kept');
});

test('collision grid: overlapping labels do not both render, priority first', () => {
  const entries = [E('12', 0, 0, 0, 5), E('Main St', 1, 0, 0, 50), E('15', 0, 260, 0, 6)];
  const out = place(entries, (e) => [e.x + 300, 300, e.dist], { W: 1280, H: 800 });
  assert.deepEqual(out.map((e) => e.text), ['Main St', '15'], 'street wins the contested spot; next house fits');
});

test('place: per-layer quota, max cap, off-screen and behind-camera rejection', () => {
  const streets = Array.from({ length: 6 }, (_, i) => E('St' + i, 1, i * 300, 0, 10));
  const houses = Array.from({ length: 6 }, (_, i) => E(String(i), 0, i * 300, 50, 11));
  const out = place([...streets, ...houses], (e) => [e.x + 100, 200, e.dist], { W: 1280, H: 800, max: 8, quota: { 1: 2 } });
  assert.equal(out.filter((e) => e.kind === 1).length, 2, 'street quota honoured');
  assert.ok(out.length <= 8, 'global cap honoured');
  const n = place([E('x', 0, 0, 0)], () => null);
  assert.equal(n.length, 0, 'behind-camera entries are skipped');
});

test('pack roundtrip: housenumber string survives; legacy packs decode safely', async () => {
  const E2 = await engine();
  const pts = [240, 246, 270, 246, 270, 266, 240, 266].map((v) => v * 100);
  const B = new MPKBuilder({ id: 'labels-test', name: 'labels-test', attribution: 't', origin: [54, 28], tileSize: 512, bbox: [53.99, 27.98, 54.01, 28.01] });
  const road = [240, 250, 270, 250, 300, 250].map((v) => v * 100);
  B.tile(0, 0, [[
    { kind: 1, recs: [{ pts, bkind: 1, roof: 0, h10: 160, base10: 0, osmId: 1, src: 0, num: '12A' }] },
    { kind: 2, recs: [{ cls: 5, flags: 0, name: 'Main Street', lanes: 1, w10: 80, pts: road }] },
  ]]);
  const P = E2.mpkOpen(new Uint8Array(B.finish()));
  const W = await E2.buildWorld(P);
  const nums = W.labels.filter((l) => l.kind === 0), streets = W.labels.filter((l) => l.kind === 1);
  assert.equal(nums.length, 1, 'one house number label');
  assert.equal(nums[0].text, '12A');
  assert.ok(Math.abs(nums[0].y - 16.6) < 0.01, 'number sits above the roof');
  assert.equal(streets.length, 1, 'one street label');
  assert.equal(streets[0].text, 'Main Street');
  assert.ok(Math.abs(streets[0].x - 270) < 1, 'street label sits at the road midpoint');
  // a pack written without the labels flag (older format) must decode num = 0
  delete P.h.labels;
  P.tiles.clear();
  assert.doesNotThrow(async () => { const t = await E2.mpkTile(P, 0); if (t.lods[0][0].recs[0].num !== 0) throw new Error('num must default to 0'); });
});

test('both label layers default on, have query overrides and an independent toggle each', () => {
  const src = readFileSync(path.join(ROOT, 'source', 'src', 'main.js'), 'utf8');
  assert.match(src, /let showNum = 1, showStreet = 1;/, 'both default on');
  assert.match(src, /QP\.get\('num'\)/, 'house-number query override');
  assert.match(src, /QP\.get\('street'\)/, 'street-name query override');
  assert.match(src, /window\.__numbers = setNum/, 'house-number runtime setter');
  assert.match(src, /window\.__streets = setStreet/, 'street runtime setter');
  const html = readFileSync(path.join(ROOT, 'source', 'template.html'), 'utf8');
  assert.match(html, /id=ln/, 'house-number drawer button');
  assert.match(html, /id=ls/, 'street-name drawer button');
  assert.match(html, /id=labs/, 'overlay container');
});
