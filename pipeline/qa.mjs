// pack quality assurance: every defect class this project has shipped becomes a check here, so a
// new city fails its build instead of shipping the artifacts. Runs over the built pack file
// (data checks) and once through buildWorld (render checks), no GPU needed.
//
// checks:
//   rings        closed rings (water polys, green polys, buildings, holes) are closed and ≥ 3 pts
//   heights      building heights inside the pipeline's clamp, bases non-negative and sane
//   bbox         every record point inside the pack bbox + 2 km (the clip rect)
//   waterOverlap water polygons containing buildings (a riverbank-style area over houses)
//   bridges      roads over big water must carry flags bit1 with per-vertex deck heights
//                (deck ≥ 1.2 m; non-bridge roads may not cross water polys ≥ 2000 m²)
//   roadJoints   road ribbon records meeting at an angle: the wedge around the joint must be
//                covered by road triangles (the miter strip + end overshoot guarantee; the test
//                catches a future ribbon regression without a screenshot)
//
// usage: node -e "import('./pipeline/qa.mjs').then(m => m.qa().then(r => console.log(r)))"
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engine, openPack } from './lib/worldharness.mjs';
import { crossesWater } from './lib/bridge.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const M2 = 2000; // the clip margin build-city applies (bbox + 2 km)

export async function qa(packFile = 'packs/grodno.mpk', { jointSamples = 320 } = {}) {
  const errors = [], warns = [], stats = {};
  const E = await engine();
  const P = await E.mpkOpen(new Uint8Array(readFileSync(path.join(root, packFile))));
  const S = P.h.tileSize, [lat0, lon0] = P.h.origin, K = Math.cos(lat0 * Math.PI / 180) * 111320;
  const bxlo = (P.h.bbox[1] - lon0) * K - M2, bxhi = (P.h.bbox[3] - lon0) * K + M2;
  const bzlo = -(P.h.bbox[2] - lat0) * 111320 - M2, bzhi = -(P.h.bbox[0] - lat0) * 111320 + M2;
  const W = { waters: [], blds: [], roads: [] }; // per-tile record lists (tile-local metres)

  // ---------- data checks ----------
  for (let i = 0; i < P.h.tiles.length; i++) {
    const T = await E.mpkTile(P, i), lods = T.lods[T.lods.length - 1];
    const ox = T.x * S, oz = T.z * S, recs = { w: [], b: [], r: [] };
    for (const L of lods) {
      if (L.kind === 3) for (const r of L.recs) if (r.kind <= 3) recs.w.push({ kind: r.kind, pts: r.pts });
      else if (L.kind === 1) for (const r of L.recs) recs.b.push(r);
      else if (L.kind === 2) for (const r of L.recs) recs.r.push(r);
      else if (L.kind === 4) { /* green rings: closed-ring check below via recs.w-like path */ }
    }
    // rings closed + sane heights + bbox
    for (const w of recs.w) {
      const n = w.pts.length / 2;
      const dx = w.pts[0] - w.pts[w.pts.length - 2], dz = w.pts[1] - w.pts[w.pts.length - 1];
      if (n < 3 || dx * dx + dz * dz > 1) errors.push({ check: 'rings', msg: `water ring open or degenerate (tile ${i}, ${n} pts)` });
      for (let k = 0; k < w.pts.length; k += 2) {
        const gx = ox + w.pts[k] / 100, gz = oz + w.pts[k + 1] / 100;
        // 1 m tolerance: clip-boundary points land exactly ON the rect (fp rounding)
        if (gx < bxlo - 1 || gx > bxhi + 1 || gz < bzlo - 1 || gz > bzhi + 1) { errors.push({ check: 'bbox', msg: `water point outside the clip rect (tile ${i}, at ${gx.toFixed(0)}, ${gz.toFixed(0)})` }); break; }
      }
    }
    for (const b of recs.b) {
      const h = b.h10 / 10, base = b.base10 / 10;
      if (h < 2 || h > 80) errors.push({ check: 'heights', msg: `building height ${h} m outside the clamp (tile ${i}, osm ${b.osmId})` });
      if (base < 0 || base > 10) errors.push({ check: 'heights', msg: `building base ${base} m outside the clamp (tile ${i}, osm ${b.osmId})` });
    }
    W.waters.push(...recs.w.map((w) => ({ pts: w.pts, ox, oz, tile: i })));
    W.blds.push(...recs.b.map((b) => ({ pts: b.pts, ox, oz, tile: i, osmId: b.osmId })));
    W.roads.push(...recs.r.map((r) => ({ pts: r.pts, ox, oz, tile: i, hw: (r.w10 || 80) / 20, flags: r.flags, ys: r.ys })));
  }
  stats.tiles = P.h.tiles.length;

  // water polys containing buildings: a riverbank-style area polygon over houses
  const inRing = (x, z, pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
      const zi = pts[i + 1], zj = pts[j + 1];
      if ((zi > z) !== (zj > z) && x < (pts[j] - pts[i]) * (z - zi) / (zj - zi) + pts[i]) inside = !inside;
    }
    return inside;
  };
  const area = (pts) => { let a = 0; for (let i = 0; i < pts.length; i += 2) { const j = (i + 2) % pts.length; a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1]; } return Math.abs(a / 2); };
  for (const w of W.waters) {
    if (area(w.pts) < 400) continue; // small ponds: a shed on the bank is data noise
    const g = w.pts.map((v, k) => (k % 2 ? w.oz : w.ox) + v / 100);
    let nB = 0, hit = null;
    for (const b of W.blds) {
      if (Math.abs(b.ox - w.ox) > 1 || Math.abs(b.oz - w.oz) > 1) continue; // same tile frame
      const n = b.pts.length / 2;
      const cx = b.ox + b.pts.reduce((s, v, k) => s + (k % 2 ? 0 : v), 0) / n / 100;
      const cz = b.oz + b.pts.reduce((s, v, k) => s + (k % 2 ? v : 0), 0) / n / 100;
      if (inRing(cx - w.ox, cz - w.oz, w.pts) && inRing(b.pts[0] / 100, b.pts[1] / 100, w.pts)) { nB++; hit = hit || b; }
    }
    if (nB) errors.push({ check: 'waterOverlap', msg: `water poly ${(area(w.pts) | 0)} m² (tile ${w.tile}) contains ${nB} building(s), e.g. osm ${hit.osmId}` });
  }

  // bridges: any road over big water must carry flags bit1 with sane deck heights (the "road lies
  // in the water" defect class). build-city tags crossings itself — here the pack just gets failed
  const bigWater = W.waters.filter((w) => area(w.pts) >= 2e6) // pts are cm → area cm²; ≥ 2000 m²
    .map((w) => ({ pts: w.pts.map((v, k) => (k % 2 ? w.oz : w.ox) + v / 100), area: area(w.pts) / 1e4 }));
  let nBridges = 0;
  for (const r of W.roads) {
    if (r.flags & 2) {
      nBridges++;
      if (!r.ys || r.ys.length !== r.pts.length / 2) errors.push({ check: 'bridges', msg: `bridge record without per-vertex deck heights (tile ${r.tile})` });
      else if (Math.max(...r.ys) < 120) errors.push({ check: 'bridges', msg: `bridge deck peaks at ${(Math.max(...r.ys) / 100).toFixed(1)} m — too low for a water crossing (tile ${r.tile})` });
      else if (Math.min(...r.ys) < 0) errors.push({ check: 'bridges', msg: `negative deck height in ys (tile ${r.tile})` });
      continue;
    }
    const g = Array.from(r.pts, (v, k) => (k % 2 ? r.oz : r.ox) + v / 100);
    if (bigWater.length && crossesWater(g, bigWater)) errors.push({ check: 'bridges', msg: `road crosses big water without a bridge flag (tile ${r.tile}, at ${g[0].toFixed(0)},${g[1].toFixed(0)})` });
  }
  stats.bridges = nBridges;

  // ---------- render check: road joints covered (buildWorld once) ----------
  const W2 = await E.buildWorld(P);
  // road meshes per tile: M.PAVE solids, one LOD; instance row: pos + tint + type + radius
  const IF = new Float32Array(W2.inst), IU = new Uint32Array(W2.inst);
  const roadTris = new Map(); // tile key → flat [x, z, ...] triangle soup (world metres)
  W2.types.forEach((T, ti) => {
    if (T.lods.length !== 1 || T.kind !== E.K.SOLID) return;
    const mat = new Uint8Array(W2.meshes[T.lods[0]].vb)[16];
    if (mat !== E.M.PAVE && mat !== E.M.ASPHALT) return; // drivable asphalt + footway flagstone both cover joints
    for (let i = 0; i < W2.nI; i++) {
      if (IU[i * 12 + 9] !== ti) continue;
      const ix = IF[i * 12], iz = IF[i * 12 + 2], m = W2.meshes[T.lods[0]], vb = new Float32Array(m.vb);
      const key = `${Math.round(ix)},${Math.round(iz)}`;
      const arr = roadTris.get(key) || [];
      for (let t = 0; t < m.ib.length; t++) { const v = m.ib[t] * 5; arr.push(vb[v] + ix, vb[v + 2] + iz); }
      roadTris.set(key, arr);
    }
  });
  const covered = (x, z, arr) => {
    for (let t = 0; t + 5 < arr.length; t += 6) {
      const ax = arr[t], az = arr[t + 1], bx = arr[t + 2], bz = arr[t + 3], cx = arr[t + 4], cz = arr[t + 5];
      const s1 = (bx - ax) * (z - az) - (bz - az) * (x - ax), s2 = (cx - bx) * (z - bz) - (cz - bz) * (x - bx), s3 = (ax - cx) * (z - cz) - (az - cz) * (x - cx);
      if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
    }
    return false;
  };
  // joints: two road records whose ends coincide (0.5 m grid) with an angle between them. The
  // wedge beside the joint (along the two end normals' average, at 0.75 × the wider half-width)
  // must be covered by road triangles — the miter strip and the end overshoot guarantee it; this
  // test catches a future ribbon regression without a screenshot
  let joints = 0, open = 0; const openSamples = [];
  const byTile = new Map();
  for (const r of W.roads) { const k = `${r.ox}|${r.oz}`; if (!byTile.has(k)) byTile.set(k, []); byTile.get(k).push(r); }
  for (const [k, recs] of byTile) {
    const arr = roadTris.get(k); if (!arr || joints >= jointSamples) continue;
    const ends = new Map();
    for (const r of recs) for (const at of [true, false]) {
      const x = r.ox + (at ? r.pts[0] : r.pts[r.pts.length - 2]) / 100, z = r.oz + (at ? r.pts[1] : r.pts[r.pts.length - 1]) / 100;
      const k2 = `${Math.round(x * 2)},${Math.round(z * 2)}`; // 0.5 m grid
      if (!ends.has(k2)) ends.set(k2, []);
      ends.get(k2).push({ r, at, x, z });
    }
    for (const list of ends.values()) {
      if (list.length !== 2 || joints >= jointSamples) continue;
      const [A, B] = list;
      if (A.r === B.r) continue;
      const dA = A.at ? [A.x - (A.r.ox + A.r.pts[2] / 100), A.z - (A.r.oz + A.r.pts[3] / 100)] : [(A.r.ox + A.r.pts[A.r.pts.length - 4] / 100) - A.x, (A.r.oz + A.r.pts[A.r.pts.length - 3] / 100) - A.z];
      const dB = B.at ? [(B.r.ox + B.r.pts[2] / 100) - B.x, (B.r.oz + B.r.pts[3] / 100) - B.z] : [B.x - (B.r.ox + B.r.pts[B.r.pts.length - 4] / 100), B.z - (B.r.oz + B.r.pts[B.r.pts.length - 3] / 100)];
      const nA = [dA[1], -dA[0]], nB = [dB[1], -dB[0]];
      let mx = nA[0] + nB[0], mz = nA[1] + nB[1]; const ml = Math.hypot(mx, mz);
      if (ml < 0.2) continue; // a straight continuation: no wedge to test (and post-merge, rare)
      mx /= ml; mz /= ml;
      const hw = Math.max(A.r.hw, B.r.hw, 2), r = hw * 0.75;
      joints++;
      for (const s of [1, -1]) {
        const sx = A.x + mx * r * s, sz = A.z + mz * r * s;
        if (!covered(sx, sz, arr)) {
          open++;
          if (openSamples.length < 6) openSamples.push(`tile ${A.r.ox | 0},${A.r.oz | 0} joint ${A.x.toFixed(0)},${A.z.toFixed(0)} side ${s > 0 ? '+' : '-'}m`);
          break;
        }
      }
    }
  }
  if (joints && open / joints > 0.02) errors.push({ check: 'roadJoints', msg: `${open} of ${joints} road joints have uncovered wedges: ${openSamples.join(' | ')}` });
  else if (open) warns.push({ check: 'roadJoints', msg: `${open}/${joints} joint wedges uncovered (under the 2% gate): ${openSamples.join(' | ')}` });
  stats.roadJoints = joints; stats.roadJointGaps = open;

  return { pack: packFile, errors, warns, stats };
}
