// cap span scan: for every cap-bearing building, the worst horizontal span of a cap slope
// (wall mid → ridge point) and the bbox/footprint ratio — ranks the "tent" artifacts.
// usage: node tools/capspan.mjs
import { openPack, engine } from '../pipeline/lib/worldharness.mjs';

const E = await engine();
const P = await openPack(process.argv[2] || 'packs/grodno.mpk');
const [lat0, lon0] = P.h.origin, K = Math.cos(lat0 * Math.PI / 180) * 111320;
const toGeo = (x, z) => [lat0 - z / 111320, lon0 + x / K];
const S = P.h.tileSize;

const rows = [];
let caps = 0, nonConvex = 0;
for (let i = 0; i < P.h.tiles.length; i++) {
  const T = await E.mpkTile(P, i), lods = T.lods[T.lods.length - 1];
  const ox = T.x * S, oz = T.z * S;
  for (const L of lods) if (L.kind === 1) for (const r of L.recs) {
    const n = r.pts.length / 2; if (n < 3) continue;
    const X = [], Z = [];
    for (let k = 0; k < n; k++) { X.push(ox + r.pts[k * 2] / 100); Z.push(oz + r.pts[k * 2 + 1] / 100); }
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, A = 0;
    for (let k = 0; k < n; k++) { const j = (k + 1) % n; A += X[k] * Z[j] - X[j] * Z[k];
      x0 = Math.min(x0, X[k]); x1 = Math.max(x1, X[k]); z0 = Math.min(z0, Z[k]); z1 = Math.max(z1, Z[k]); }
    const area = Math.abs(A / 2), h = r.h10 / 10;
    const roof = r.roof === 1 || r.roof === 2 ? r.roof : 0;
    if (!roof || area > 4000 || (r.src & 16)) continue;
    caps++;
    // convexity (sign flips over consecutive edges)
    let pos = 0, neg = 0;
    for (let k = 0; k < n; k++) { const a = k, b = (k + 1) % n, c = (k + 2) % n;
      const cr = (X[b] - X[a]) * (Z[c] - Z[a]) - (Z[b] - Z[a]) * (X[c] - X[a]);
      if (cr > 1e-9) pos++; else if (cr < -1e-9) neg++; }
    const convex = !(pos && neg);
    if (!convex) nonConvex++;
    // replicate the engine's bbox ridge: slope span = distance from each wall mid to the ridge line
    const axX = x1 - x0 >= z1 - z0, pc = axX ? (z0 + z1) / 2 : (x0 + x1) / 2;
    let span = 0;
    for (let k = 0; k < n; k++) { const j = (k + 1) % n;
      const mx = (X[k] + X[j]) / 2, mz = (Z[k] + Z[j]) / 2;
      span = Math.max(span, Math.abs((axX ? mz : mx) - pc)); }
    const bboxA = (x1 - x0) * (z1 - z0);
    const [lat, lon] = toGeo((x0 + x1) / 2, (z0 + z1) / 2);
    rows.push({ span: span | 0, roof: roof === 1 ? 'g' : 'h', convex, bboxR: +(bboxA / area).toFixed(1), w: x1 - x0 | 0, l: z1 - z0 | 0, h: h | 0, lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
  }
}
console.log(`caps ${caps}, non-convex ${nonConvex}`);
rows.sort((a, b) => b.span - a.span);
console.log('\n-- worst slope spans (wall mid → ridge, metres) --');
for (const r of rows.slice(0, 20)) console.log(JSON.stringify(r));
console.log('\n-- span histogram --');
const hist = {};
for (const r of rows) hist[Math.min(9, r.span / 10 | 0)] = (hist[Math.min(9, r.span / 10 | 0)] || 0) + 1;
for (const k of Object.keys(hist).sort((a, b) => a - b)) console.log(`${k * 10}-${k * 10 + 9} m: ${hist[k]}`);
