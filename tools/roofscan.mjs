// roof sanity scan over a city pack: ranks cap-bearing buildings by visual oddness and lists
// height outliers — finds what a "wrong roof" screenshot is actually showing.
// usage: node tools/roofscan.mjs [packs/grodno.mpk]
import { openPack, engine } from '../pipeline/lib/worldharness.mjs';

const E = await engine();
const P = await openPack(process.argv[2] || 'packs/grodno.mpk');
const [lat0, lon0] = P.h.origin, K = Math.cos(lat0 * Math.PI / 180) * 111320;
const toGeo = (x, z) => [lat0 - z / 111320, lon0 + x / K];
const S = P.h.tileSize;

// cross-product sign changes over the ring (CCW): >0 = non-convex
const convexity = (X, Z, n) => { let flips = 0, pos = 0, neg = 0;
  for (let i = 0; i < n; i++) { const a = i, b = (i + 1) % n, c = (i + 2) % n;
    const cr = (X[b] - X[a]) * (Z[c] - Z[a]) - (Z[b] - Z[a]) * (X[c] - X[a]);
    if (cr > 1e-9) pos++; else if (cr < -1e-9) neg++; }
  return pos && neg ? 1 : 0;
};

let nB = 0, caps = 0, capTall = 0, capNonConvex = 0, capDiagonal = 0;
const capOdd = [], tall = [];
for (let i = 0; i < P.h.tiles.length; i++) {
  const T = await E.mpkTile(P, i), lods = T.lods[T.lods.length - 1];
  const ox = T.x * S, oz = T.z * S;
  for (const L of lods) if (L.kind === 1) for (const r of L.recs) {
    nB++;
    const n = r.pts.length / 2; if (n < 3) continue;
    const X = [], Z = [];
    for (let k = 0; k < n; k++) { X.push(ox + r.pts[k * 2] / 100); Z.push(oz + r.pts[k * 2 + 1] / 100); }
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, A = 0;
    for (let k = 0; k < n; k++) { const j = (k + 1) % n; A += X[k] * Z[j] - X[j] * Z[k];
      x0 = Math.min(x0, X[k]); x1 = Math.max(x1, X[k]); z0 = Math.min(z0, Z[k]); z1 = Math.max(z1, Z[k]); }
    const area = A / 2, h = r.h10 / 10, base = r.base10 / 10;
    let holes = 0; if (L.kind === 1 && (r.src & 16)) { /* holes live in kind-6 layers, counted below via cityTile in the engine; approximate by src bit */ }
    const roof = r.roof === 1 || r.roof === 2 ? r.roof : 0;
    const capOn = roof && area <= 4000 && !(r.src & 16);
    const [lat, lon] = toGeo((x0 + x1) / 2, (z0 + z1) / 2);
    if (h >= 20) tall.push({ h, roof, area: area | 0, lat: +lat.toFixed(5), lon: +lon.toFixed(5), bkind: r.bkind });
    if (!capOn) continue;
    caps++;
    const halfP = (Math.min(x1 - x0, z1 - z0)) / 2, len = Math.max(x1 - x0, z1 - z0);
    const rise = Math.max(0.15, Math.min(Math.min((roof === 1 ? 0.58 : 0.5) * halfP, 3.4), h - 2.2));
    const pitch = Math.atan2(rise, halfP) * 180 / Math.PI;
    const nc = convexity(X, Z, n), diag = (x1 - x0) * (z1 - z0) / Math.max(area, 1);
    let why = [];
    if (h > 15) { why.push(`tall ${h.toFixed(0)}m`); capTall++; }
    if (nc) { why.push('non-convex'); capNonConvex++; }
    if (diag > 1.8) { why.push(`diagonal bbox×${diag.toFixed(1)}`); capDiagonal++; }
    if (why.length) capOdd.push({ why: why.join(', '), roof: roof === 1 ? 'gable' : 'hip', pitch: pitch | 0, w: halfP * 2 | 0, len: len | 0, h: h | 0, area: area | 0, lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
  }
}
console.log(`buildings ${nB}, caps ${caps} (tall>${capTall}, non-convex ${capNonConvex}, diagonal ${capDiagonal})`);
console.log('\n-- caps with an oddity (worst first: tall / non-convex) --');
capOdd.sort((a, b) => (b.why.includes('tall') ? 4 : 0) + (b.why.includes('non-convex') ? 2 : 0) - (a.why.includes('tall') ? 4 : 0) - (a.why.includes('non-convex') ? 2 : 0));
for (const o of capOdd.slice(0, 25)) console.log(JSON.stringify(o));
console.log('\n-- buildings ≥ 20 m (roof flag shown) --');
tall.sort((a, b) => b.h - a.h);
for (const t of tall.slice(0, 25)) console.log(JSON.stringify(t));
