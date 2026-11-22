// water sanity scan: which water polygons (kind 0-3) contain buildings or road vertices —
// a riverbank-style area polygon (land + water together) renders as a teal stain over streets.
// usage: node tools/waterscan.mjs
import { openPackFile } from '../pipeline/test/helpers.mjs';

const P = await openPackFile('packs/grodno.mpk');
const S = P.h.tileSize;
const [lat0, lon0] = P.h.origin, K = Math.cos(lat0 * Math.PI / 180) * 111320;
const toGeo = (x, z) => [lat0 - z / 111320, lon0 + x / K];

// collect water polys (kinds 0-3, closed rings) and buildings per tile, then test overlaps
const polys = [], blds = [], roadPts = [];
for (let i = 0; i < P.h.tiles.length; i++) {
  const T = await globalThis.mpkTile(P, i), lods = T.lods[T.lods.length - 1];
  const ox = T.x * S, oz = T.z * S;
  for (const L of lods) {
    if (L.kind === 3) {
      for (const r of L.recs) if (r.kind <= 3) {
        const pts = [];
        for (let k = 0; k + 1 < r.pts.length; k += 2) pts.push([ox + r.pts[k] / 100, oz + r.pts[k + 1] / 100]);
        let A = 0;
        for (let k = 0; k < pts.length; k++) { const j = (k + 1) % pts.length; A += pts[k][0] * pts[j][1] - pts[j][0] * pts[k][1]; }
        polys.push({ pts, area: Math.abs(A / 2), tile: i, wkind: r.kind });
      }
    } else if (L.kind === 1) {
      for (const r of L.recs) {
        const pts = [];
        for (let k = 0; k + 1 < r.pts.length; k += 2) pts.push([ox + r.pts[k] / 100, oz + r.pts[k + 1] / 100]);
        blds.push({ pts, osmId: r.osmId, tile: i });
      }
    } else if (L.kind === 2) {
      for (const r of L.recs) for (let k = 0; k + 1 < r.pts.length; k += 2) roadPts.push([ox + r.pts[k] / 100, oz + r.pts[k + 1] / 100]);
    }
  }
}
console.log(`water polys ${polys.length} (total ${(polys.reduce((s, p) => s + p.area, 0) / 1e6).toFixed(2)} km²), buildings ${blds.length}, road vertices ${roadPts.length}`);

const inRing = (x, z, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    if ((pts[i][1] > z) !== (pts[j][1] > z) && x < (pts[j][0] - pts[i][0]) * (z - pts[i][1]) / (pts[j][1] - pts[i][1]) + pts[i][0]) inside = !inside;
  return inside;
};

for (const p of polys) {
  if (p.area < 400) continue; // ponds under 400 m²: a shed inside is noise, real data quirks live in big polys
  let nB = 0, nR = 0, worstB = null;
  for (const b of blds) {
    // a building counts when its FIRST vertex and its centroid are both inside (cheap double test)
    const cx = b.pts.reduce((s, q) => s + q[0], 0) / b.pts.length, cz = b.pts.reduce((s, q) => s + q[1], 0) / b.pts.length;
    if (inRing(cx, cz, p.pts) && inRing(b.pts[0][0], b.pts[0][1], p.pts)) { nB++; worstB = b; }
  }
  for (const r of roadPts) if (inRing(r[0], r[1], p.pts)) nR++;
  if (nB || nR > 4) {
    const [lat, lon] = toGeo((p.pts.reduce((s, q) => s + q[0], 0) / p.pts.length), (p.pts.reduce((s, q) => s + q[1], 0) / p.pts.length));
    console.log(`POLY tile ${p.tile} kind${p.wkind} ${(p.area | 0)} m²  buildings inside: ${nB}  road vertices inside: ${nR}  @ ${lat.toFixed(5)}, ${lon.toFixed(5)}` + (worstB ? `  (e.g. building ${worstB.osmId})` : ''));
  }
}
