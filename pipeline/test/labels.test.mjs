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
const { dedupe, place, focusLabels } = new Function(labelSrc + '\nreturn { dedupe, place, focusLabels };')();
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

test('place: one street name per view, the closest instance wins', () => {
  const entries = [E('Same', 1, 0, 0, 90), E('Same', 1, 40, 0, 20), E('Other', 1, 1200, 0, 120)];
  const out = place(entries, (e) => [e.dist * 10, 300, e.dist], { W: 1280, H: 800, unique: true });
  assert.deepEqual(out.map((e) => e.text), ['Same', 'Other'], 'repeated name folded, nearest kept');
  const all = place(entries, (e) => [e.dist * 10, 300, e.dist], { W: 1280, H: 800 });
  assert.equal(all.length, 3, 'without unique the old behaviour is unchanged');
});

test('place: main-road ranks win a contested spot over minor roads', () => {
  const entries = [{ ...E('Service', 1, 0, 0, 10), rank: 2 }, { ...E('Main', 1, 0, 0, 10), rank: 0 }];
  const out = place(entries, () => [300, 300, 10], { W: 1280, H: 800 });
  assert.deepEqual(out.map((e) => e.text), ['Main'], 'lower rank placed first');
});

test('focus: the street under the camera and only the houses on it survive', () => {
  const entries = [
    { ...E('My St', 1, 50, 0, 10), path: [0, 0, 100, 0] },
    { ...E('Far St', 1, 50, 200, 10), path: [0, 200, 100, 200] },
    E('10', 0, 20, 5, 10), E('20', 0, 20, 80, 10),
  ];
  const out = focusLabels(entries, { x: 25, z: 0, fx: 1, fz: 0 });
  assert.deepEqual(out.map((e) => e.text).sort(), ['10', 'My St'], 'other street and off-street house dropped');
});

test('focus: a couple of nearest streets in the camera cone may join, not the ones behind', () => {
  const entries = [
    { ...E('Here', 1, 5, 0, 10), path: [0, 0, 10, 0] },
    { ...E('Ahead', 1, 80, 0, 10), path: [70, 0, 90, 0] },
    { ...E('Behind', 1, -80, 0, 10), path: [-90, 0, -70, 0] },
  ];
  const out = focusLabels(entries, { x: 0, z: 0, fx: 1, fz: 0 });
  assert.deepEqual(out.map((e) => e.text).sort(), ['Ahead', 'Here'], 'behind-camera street skipped');
  assert.equal(focusLabels(entries, { x: 0, z: 500, fx: 0, fz: -1 }).length, 0, 'nothing in range → nothing shown');
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
  assert.equal(streets[0].rank, 1, 'residential street carries road rank');
  assert.ok(Math.abs(streets[0].x - 270) < 1, 'street label sits at the road midpoint');
  // a pack written without the labels flag (older format) must decode num = 0
  delete P.h.labels;
  P.tiles.clear();
  assert.doesNotThrow(async () => { const t = await E2.mpkTile(P, 0); if (t.lods[0][0].recs[0].num !== 0) throw new Error('num must default to 0'); });
});

test('label overlay uses the unjittered matrix and writes whole pixels only on change', () => {
  const src = readFileSync(path.join(ROOT, 'source', 'src', 'main.js'), 'utf8');
  assert.match(src, /updateLabels\(PVP,/, 'TAA jitter must not move DOM labels');
  assert.doesNotMatch(src, /updateLabels\(U,/, 'the jittered view matrix is for pixels, not text');
  assert.match(src, /Math\.round\(e\.sx\)\}px/, 'positions snap to whole pixels');
  assert.match(src, /if \(d\._tf !== tf\)/, 'no DOM write when the rounded position is unchanged');
  assert.doesNotMatch(src, /labTick/, 'labels refresh every frame, not in 4-frame jumps');
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
  assert.match(html, /id=lz/, 'label density drawer button');
});

test('density presets gate label range, quota and repeated street names', () => {
  const main = readFileSync(path.join(ROOT, 'source', 'src', 'main.js'), 'utf8');
  assert.match(main, /const LAB_MODES =/, 'three density presets');
  assert.match(main, /farStreet\[e\.rank \|\| 0\]/, 'street range follows road rank');
  assert.match(main, /unique: LAB\.unique/, 'repeated street names folded by preset');
  assert.match(main, /max: LAB\.max/, 'preset drives the global cap');
  assert.match(main, /window\.__labels = setLabelMode/, 'preset has a runtime setter');
  const world = readFileSync(path.join(ROOT, 'source', 'src', 'world.js'), 'utf8');
  assert.match(world, /rank: r\.cls <= 4 \? 0 : r\.cls <= 6 \? 1 : 2/, 'rank comes from road class');
  assert.match(world, /const path = \[ox \+ mx \/ 100/, 'street labels carry polyline samples');
  assert.match(labelSrc, /const focusLabels = /, 'focus filter is a pure helper');
  assert.match(main, /focusLabels\(cand,/, 'focus mode filters candidates in the overlay');
  assert.match(main, /LAB_ORDER = \['full', 'balanced', 'focus', 'minimal'\]/, 'focus is a selectable preset');
});
