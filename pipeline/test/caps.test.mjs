// roof caps (citygen's near roof slot): a gable/hip cap may only sit on a CONVEX ring — on a
// notched (L/U/T-shaped) ring the cap slopes bridge the notch, spanning up to 50 m of open air
// (the "giant roof over the courtyard" artifact: 524 such caps in the first Grodno pack, the
// worst spanning 51 m). The ridge must also follow the longest wall edge, not the bbox long
// side — a 45°-rotated house got its ridge across the walls.
//
// The gate lives in citygen.js cityBuilding (convexity sign flips + longest-edge ridge). Two
// nets here: an engine test on a synthetic three-building pack — every near-roof vertex must
// stay inside its own footprint (a tent vertex lands in the notch) — and a data scan bounding
// the slope span citygen's ridge algorithm produces on the real pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPackFile } from './helpers.mjs';
import { engine } from '../lib/worldharness.mjs';
import { MPKBuilder } from '../lib/pack.mjs';

const BLOD0 = 260;    // citygen.js facade/roof LOD switch, metres
const CM = 100;       // metres → cm

// synthetic pack: three isolated buildings, one per tile, so tint buckets never mix them
const mkPack = () => {
  const rec = (pts, roof) => ({ pts: pts.map((v) => v * CM), bkind: 1, roof, h10: 8 * 10, base10: 0, osmId: 1, src: 0 });
  // buildings in WORLD metres; loc subtracts the tile corner. L at tile (0,0) world 0-40;
  // a 12 m square at 45° in tile (1,0) about world (562, 50); a 30 × 12 m rect in tile (2,0)
  const L = [[0, 0], [40, 0], [40, 10], [15, 10], [15, 30], [0, 30]];           // notched, 700 m²
  const rot = []; { const r = 8.49; for (let k = 0; k < 4; k++) { const a = Math.PI / 4 + k * Math.PI / 2; rot.push([562 + r * Math.cos(a), 50 + r * Math.sin(a)]); } }
  const rect = [[1044, 40], [1074, 40], [1074, 52], [1044, 52]];
  // tile-local pts: subtract the tile corner (docs/mpk-format.md), FLAT cm array (the encoder
  // writes pts verbatim — nested pairs become zeros); tiles (0,0), (1,0), (2,0)
  const loc = (tx, pts) => pts.flatMap(([x, z]) => [x - tx * 512, z]);
  const B = new MPKBuilder({ id: 'caps-test', name: 'caps-test', attribution: 'test', origin: [54, 28], tileSize: 512, bbox: [53.99, 27.98, 54.02, 28.02] });
  B.tile(0, 0, [[{ kind: 1, recs: [rec(loc(0, L), 1)] }]]);
  B.tile(1, 0, [[{ kind: 1, recs: [rec(loc(1, rot), 2)] }]]);
  B.tile(2, 0, [[{ kind: 1, recs: [rec(loc(2, rect), 1)] }]]);
  B.graph([[0, 0]], [[{ a: 0, b: 0, cls: 6, flags: 0, name: '', lanes: 1, speed: 20, len: 1 }]]);
  return B.finish();
};

// point inside a ring (metres), with a distance tolerance for vertices ON the boundary
const inRing = (x, z, pts, tol) => {
  const n = pts.length;
  let dmin = 1e9;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n;
    const ex = pts[j][0] - pts[i][0], ez = pts[j][1] - pts[i][1], L = Math.hypot(ex, ez);
    const d = Math.abs((x - pts[i][0]) * ez / L - (z - pts[i][1]) * ex / L);
    if (d < dmin) dmin = d; }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++)
    if ((pts[i][1] > z) !== (pts[j][1] > z) && x < (pts[j][0] - pts[i][0]) * (z - pts[i][1]) / (pts[j][1] - pts[i][1]) + pts[i][0]) inside = !inside;
  return inside || dmin <= tol;
};

test('roof caps: every cap vertex stays inside its own footprint (no tents over the notch)', async () => {
  const E = await engine();
  const P = E.mpkOpen(new Uint8Array(mkPack()));
  const W = await E.buildWorld(P);
  const S = P.h.tileSize;
  // the buildings, in world metres, per tile (tile corner = (tx*S, tz*S))
  const rings = [
    [[0, 0], [40, 0], [40, 10], [15, 10], [15, 30], [0, 30]],
    Array.from({ length: 4 }, (_, k) => { const a = Math.PI / 4 + k * Math.PI / 2; return [562 + 8.49 * Math.cos(a), 50 + 8.49 * Math.sin(a)]; }),
    [[1044, 40], [1074, 40], [1074, 52], [1044, 52]],
  ];
  // roof types: 2 LODs switching at BLOD0, both slots M.ROCK (walls carry 3 LODs, PLASTER near)
  const roofTypes = [];
  W.types.forEach((T) => {
    if (T.lods.length === 2 && T.d[0] === BLOD0 && T.kind === E.K.SOLID) {
      const m0 = new Uint8Array(W.meshes[T.lods[0]].vb);
      if (m0[16] === E.M.ROCK) roofTypes.push(T);
    }
  });
  assert.equal(roofTypes.length, 3, `expected a roof type per building tile, got ${roofTypes.length}`);
  const IF = new Float32Array(W.inst), IU = new Uint32Array(W.inst);
  const instByType = new Map();
  for (let i = 0; i < W.nI; i++) {
    const o = i * 12, ty = IU[o + 9];
    if (!instByType.has(ty)) instByType.set(ty, []);
    instByType.get(ty).push([IF[o], IF[o + 2]]); // x, z of the instance (the tile centre)
  }
  let capTiles = 0;
  for (const T of roofTypes) {
    const insts = instByType.get(W.types.indexOf(T));
    assert.ok(insts && insts.length === 1, 'one roof instance per tile');
    const [ix, iz] = insts[0];
    const ti = Math.round(ix / S - 0.5); // tile index in x — matches the rings array order
    const ring = rings[ti];
    const mN = W.meshes[T.lods[0]], vb = new Float32Array(mN.vb);
    assert.ok(mN.nv > 0, 'near roof slot has geometry');
    let eavesMin = 1e9;
    for (let v = 0; v < mN.nv; v++) {
      const x = vb[v * 5] + ix, z = vb[v * 5 + 2] + iz, y = vb[v * 5 + 1];
      eavesMin = min(eavesMin, y);
      assert.ok(inRing(x, z, ring, 0.2), `roof vertex ${x.toFixed(1)},${z.toFixed(1)} escapes its footprint (tile ${ti}) — a cap tent over the notch`);
    }
    if (eavesMin < 8 - 0.5) capTiles++; // a cap drops wall-top verts to the eaves; a flat top stays at h
  }
  assert.equal(capTiles, 2, `expected caps on the convex pair only (rect + rotated), got ${capTiles}`);
});

test('roof caps data: convex rings carry bounded slope spans with the longest-edge ridge', async () => {
  const P = await openPackFile('packs/grodno.mpk');
  const S = P.h.tileSize;
  const MAX_SPAN = 22; // m — a convex ring's wall-to-ridge span is its half-width; a tent is 30-50 m
  let caps = 0, gated = 0, worst = 0;
  for (let i = 0; i < P.h.tiles.length; i++) {
    const T = await globalThis.mpkTile(P, i), lods = T.lods[T.lods.length - 1];
    const ox = T.x * S, oz = T.z * S;
    for (const L of lods) if (L.kind === 1) for (const r of L.recs) {
      const roof = r.roof === 1 || r.roof === 2 ? r.roof : 0;
      if (!roof) continue;
      const n = r.pts.length / 2; if (n < 3) continue;
      const X = [], Z = [];
      for (let k = 0; k < n; k++) { X.push(ox + r.pts[k * 2] / 100); Z.push(oz + r.pts[k * 2 + 1] / 100); }
      let A = 0;
      for (let k = 0; k < n; k++) { const j = (k + 1) % n; A += X[k] * Z[j] - X[j] * Z[k]; }
      if (Math.abs(A / 2) > 4000 || (r.src & 16)) continue; // citygen's other gates: never capped anyway
      caps++;
      let pos = 0, neg = 0;
      for (let k = 0; k < n; k++) { const a = k, b = (k + 1) % n, c = (k + 2) % n;
        const cr = (X[b] - X[a]) * (Z[c] - Z[a]) - (Z[b] - Z[a]) * (X[c] - X[a]);
        if (cr > 1e-9) pos++; else if (cr < -1e-9) neg++; }
      if (pos && neg) { gated++; continue; } // non-convex: tagged in data, dropped by the renderer gate
      let bl = 0, rx = 1, rz = 0;
      for (let k = 0; k < n; k++) { const j = (k + 1) % n, ex = X[j] - X[k], ez = Z[j] - Z[k], el = ex * ex + ez * ez;
        if (el > bl) { bl = el; const il = 1 / Math.max(Math.sqrt(el), 1e-9); rx = ex * il; rz = ez * il; } }
      const pdx = -rz, pdz = rx;
      let sq = 0; for (let k = 0; k < n; k++) sq += X[k] * pdx + Z[k] * pdz;
      const pc = sq / n;
      let span = 0; for (let k = 0; k < n; k++) span = Math.max(span, Math.abs(X[k] * pdx + Z[k] * pdz - pc));
      worst = Math.max(worst, span);
      assert.ok(span <= MAX_SPAN, `convex cap slope spans ${span.toFixed(1)} m (> ${MAX_SPAN})`);
    }
  }
  assert.ok(caps > 500, `pack should carry cap tags, got ${caps}`);
  console.log(`cap tags ${caps}: ${caps - gated} convex (worst span ${worst.toFixed(1)} m), ${gated} renderer-gated notched rings`);
});
function min(a, b) { return a < b ? a : b; }
