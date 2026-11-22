// area budgets: shoelace area of the water polygon records must stay a small fraction of the pack
// bbox (Grodno ground truth ≈ 1.7%; a build that leaks rivers/lakes across the map or double-emits
// them blows past the budget), green likewise (≈ 8.8%). Exact numbers in every message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPackFile, frameOf } from './helpers.mjs';

const ringArea = (pts, ox, oz) => { // tile-local cm + tile origin cm → m²
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += (ox + pts[i * 2]) * (oz + pts[j * 2 + 1]) - (ox + pts[j * 2]) * (oz + pts[i * 2 + 1]);
  }
  return Math.abs(a) / 2 / 1e4;
};

const polyAreas = async (P) => {
  let water = 0, green = 0;
  for (const [tx, tz] of P.h.tiles) {
    const t = await globalThis.mpkTile(P, P.h.tiles.findIndex(([x, z]) => x === tx && z === tz));
    const ox = tx * 512 * 100, oz = tz * 512 * 100;
    for (const layers of t.lods) for (const L of layers) {
      if (L.kind !== 3 && L.kind !== 4) continue;
      for (const r of L.recs) {
        const a = ringArea(r.pts, ox, oz);
        if (L.kind === 3 && r.kind <= 3) water += a;
        else if (L.kind === 4) green += a;
      }
    }
  }
  return { water, green };
};

test('area budget: water polygon records ≤ 10% of the pack bbox (both packs)', async () => {
  for (const rel of ['packs/grodno.mpk', 'packs/sample.mpk']) {
    const P = await openPackFile(rel);
    const F = frameOf(P.h);
    const bbox = (F.XHI - F.XLO) * (F.ZHI - F.ZLO);
    const { water } = await polyAreas(P);
    const pct = (100 * water / bbox).toFixed(2);
    console.log(`area ${P.h.id}: water polys ${(water / 1e6).toFixed(3)} km² of ${(bbox / 1e6).toFixed(1)} km² bbox = ${pct}%`);
    assert.ok(water <= 0.10 * bbox, `${P.h.id}: water polygon area ${(water / 1e6).toFixed(3)} km² = ${pct}% of the ${(bbox / 1e6).toFixed(1)} km² bbox — budget 10%`);
  }
});

test('area budget: green polygon records ≤ 40% of the pack bbox (both packs)', async () => {
  for (const rel of ['packs/grodno.mpk', 'packs/sample.mpk']) {
    const P = await openPackFile(rel);
    const F = frameOf(P.h);
    const bbox = (F.XHI - F.XLO) * (F.ZHI - F.ZLO);
    const { green } = await polyAreas(P);
    const pct = (100 * green / bbox).toFixed(2);
    console.log(`area ${P.h.id}: green polys ${(green / 1e6).toFixed(3)} km² of ${(bbox / 1e6).toFixed(1)} km² bbox = ${pct}%`);
    assert.ok(green <= 0.40 * bbox, `${P.h.id}: green polygon area ${(green / 1e6).toFixed(3)} km² = ${pct}% of the ${(bbox / 1e6).toFixed(1)} km² bbox — budget 40%`);
  }
});
