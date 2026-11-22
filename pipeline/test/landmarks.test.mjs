// semantic spot checks against local-mapped reality: a building record near the Old Castle and the
// Kalozha church, a water record along the Neman, and every header pose inside the bbox local
// frame. Projection maths straight from the pipeline's own geoToLocal (pipeline/lib/pack.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPackFile, frameOf } from './helpers.mjs';
import { geoToLocal } from '../lib/pack.mjs';

const ORIGIN = [53.6784, 23.8291];
const CASTLE = [53.6763, 23.8228], KALOZHA = [53.6689, 23.8305], NEMAN_MID = [53.689, 23.760];

test('landmarks: building centroids within 150 m of the Old Castle and the Kalozha church', async () => {
  const P = await openPackFile('packs/grodno.mpk');
  const [cx0, cz0] = geoToLocal(CASTLE[0], CASTLE[1], ORIGIN[0], ORIGIN[1]);
  const [kx0, kz0] = geoToLocal(KALOZHA[0], KALOZHA[1], ORIGIN[0], ORIGIN[1]);
  let bestC = [1e9, 0], bestK = [1e9, 0];
  for (const [tx, tz] of P.h.tiles) {
    const t = await globalThis.mpkTile(P, P.h.tiles.findIndex(([x, z]) => x === tx && z === tz));
    const ox = tx * 512 * 100, oz = tz * 512 * 100;
    for (const layers of t.lods) for (const L of layers) {
      if (L.kind !== 1) continue;
      for (const r of L.recs) {
        let cx = 0, cz = 0;
        for (let k = 0; k < r.pts.length; k += 2) { cx += ox + r.pts[k]; cz += oz + r.pts[k + 1]; }
        cx = cx / (r.pts.length / 2) / 100; cz = cz / (r.pts.length / 2) / 100;
        const dc = Math.hypot(cx - cx0, cz - cz0), dk = Math.hypot(cx - kx0, cz - kz0);
        if (dc < bestC[0]) bestC = [dc, r.osmId];
        if (dk < bestK[0]) bestK = [dk, r.osmId];
      }
    }
  }
  console.log(`landmarks: nearest building centroid — Old Castle ${bestC[0].toFixed(1)} m (osmId ${bestC[1]}), Kalozha ${bestK[0].toFixed(1)} m (osmId ${bestK[1]})`);
  assert.ok(bestC[0] <= 150, `no building within 150 m of the Old Castle (53.6763, 23.8228) — nearest ${bestC[0].toFixed(1)} m`);
  assert.ok(bestK[0] <= 150, `no building within 150 m of the Kalozha church (53.6689, 23.8305) — nearest ${bestK[0].toFixed(1)} m`);
});

test('landmarks: a water record passes within 200 m of the Neman midpoint (53.689, 23.760)', async () => {
  const P = await openPackFile('packs/grodno.mpk');
  const [nx, nz] = geoToLocal(NEMAN_MID[0], NEMAN_MID[1], ORIGIN[0], ORIGIN[1]);
  let best = [1e9, -1], bestLine = 1e9;
  for (const [tx, tz] of P.h.tiles) {
    const t = await globalThis.mpkTile(P, P.h.tiles.findIndex(([x, z]) => x === tx && z === tz));
    const ox = tx * 512 * 100, oz = tz * 512 * 100;
    const px = nx * 100 - ox, pz = nz * 100 - oz; // probe point, tile-local cm
    for (const layers of t.lods) for (const L of layers) {
      if (L.kind !== 3) continue;
      for (const r of L.recs) for (let k = 0; k + 3 < r.pts.length; k += 2) {
        const ax = r.pts[k], az = r.pts[k + 1], bx = r.pts[k + 2], bz = r.pts[k + 3];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        const s = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
        const d = Math.hypot(ax + s * dx - px, az + s * dz - pz) / 100;
        if (d < best[0]) best = [d, r.kind];
        if (r.kind >= 8 && d < bestLine) bestLine = d;
      }
    }
  }
  console.log(`landmarks: nearest water record to the Neman midpoint: ${best[0].toFixed(1)} m (kind ${best[1]}); nearest line record ${bestLine.toFixed(1)} m`);
  assert.ok(best[0] <= 200, `no water record within 200 m of the Neman midpoint (53.689, 23.760) — nearest ${best[0].toFixed(1)} m`);
});

test('poses: every pack pose falls inside the bbox local frame (grodno carries all 6)', async () => {
  for (const [rel, nPoses] of [['packs/grodno.mpk', 6], ['packs/sample.mpk', null]]) {
    const P = await openPackFile(rel, false);
    const F = frameOf(P.h), M = 50; // 50 m margin, same convention as the geometry suite
    assert.ok(Array.isArray(P.h.poses) && P.h.poses.length >= 1, `${P.h.id}: no poses`);
    if (nPoses) assert.equal(P.h.poses.length, nPoses, `${P.h.id}: pose count changed (keys 1..${nPoses} are the documented viewpoints)`);
    for (const [i, p] of P.h.poses.entries()) {
      assert.ok(p[0] >= F.XLO - M && p[0] <= F.XHI + M && p[2] >= F.ZLO - M && p[2] <= F.ZHI + M,
        `${P.h.id}: pose ${i + 1} at (${p[0].toFixed(0)}, ${p[2].toFixed(0)}) m outside the bbox frame ` +
        `x[${F.XLO.toFixed(0)}, ${F.XHI.toFixed(0)}] z[${F.ZLO.toFixed(0)}, ${F.ZHI.toFixed(0)}]`);
    }
  }
});
