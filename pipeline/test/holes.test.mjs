// multipolygon holes (docs/mpk-format.md layer kind 6): the pipeline must emit building
// multipolygon inner rings as hole records keyed by the parent relation's osmId, and the rendered
// roofs must honour them — the regression net for the "one giant slab over the whole block" bug
// (outer-rings-only complexes covered courtyards, streets and the separately-tagged buildings
// inside them; gable caps stretched over industrial footprints).
//
// Far roof meshes (citygen's rb.f slot) are pure ear-clip tops at each building's top height, so
// per tile: Σ far-roof triangle areas ≈ Σ(outer − hole) areas, every triangle centroid sits
// inside some building outer ring and inside NO hole. Roof types are identified structurally
// (2 LODs switching at BLOD0 = 260 m, every vertex M.ROCK); the near roof slot carries the gable
// caps and is exempt (caps are sloped — their plan-projection centroids may leave the ring).
// Expected areas replicate citygen's degeneracy rules and its hole-acceptance rules exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPackFile } from './helpers.mjs';
import { engine, openPack } from '../lib/worldharness.mjs';

const BLOD0 = 260;   // citygen.js facade/roof LOD switch, metres
const MIN_HOLE = 20; // m² — citygen ignores smaller courtyards
const DEGEN = 1;     // m² — earclip's numeric-fallback slivers (≤ a few m², invisible) are exempt
                     // from the centroid sweep; a real slab spill is hundreds of m²
const S = 512;       // tile edge, metres (both packs)

const shoelace = (pts, ox, oz) => { // raw signed sum over tile-local cm + tile origin cm
  let a = 0; const n = pts.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += (ox + pts[i * 2]) * (oz + pts[j * 2 + 1]) - (ox + pts[j * 2]) * (oz + pts[i * 2 + 1]); }
  return a;
};
const pip = (x, z, pts, ox, oz) => { // point in ring (open or closed); pts cm, origin metres
  let inside = false; const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ox + pts[i * 2] / 100, zi = oz + pts[i * 2 + 1] / 100, xj = ox + pts[j * 2] / 100, zj = oz + pts[j * 2 + 1] / 100;
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

test('holes: kind-6 records have a parent building record (same tile, same osmId) and are real courtyards', async () => {
  const P = await openPackFile('packs/grodno.mpk');
  let holes = 0, holeArea = 0, unparented = 0, unmatched = 0, small = 0;
  for (const [tx, tz] of P.h.tiles) {
    const t = await globalThis.mpkTile(P, P.h.tiles.findIndex(([x, z]) => x === tx && z === tz));
    const ox = tx * S * 100, oz = tz * S * 100; // cm
    const parents = []; // building records with relation provenance (src bit 4 = osmId is a relation)
    for (const layers of t.lods) for (const L of layers) if (L.kind === 1) for (const r of L.recs) if (r.src & 16) parents.push({ osmId: r.osmId, pts: r.pts });
    for (const layers of t.lods) for (const L of layers) {
      if (L.kind !== 6) continue;
      for (const r of L.recs) {
        holes++;
        const a = shoelace(r.pts, ox, oz); // cm²·cm → m² after /2/1e4
        if (Math.abs(a) / 2 / 1e4 < MIN_HOLE) small++;
        if (!parents.some((p) => p.osmId === r.osmId)) unparented++;
        else {
          const n = r.pts.length / 2, cx0 = [], area = Math.abs(a) / 2 || 1;
          // area centroid (cm → m)
          let cx = 0, cz = 0;
          for (let i = 0; i < n; i++) { const j = (i + 1) % n, cr = (ox + r.pts[i * 2]) * (oz + r.pts[j * 2 + 1]) - (ox + r.pts[j * 2]) * (oz + r.pts[i * 2 + 1]); cx += (ox + r.pts[i * 2] + ox + r.pts[j * 2]) * cr; cz += (oz + r.pts[i * 2 + 1] + oz + r.pts[j * 2 + 1]) * cr; }
          cx = cx / (3 * a) / 100; cz = cz / (3 * a) / 100;
          if (!parents.some((p) => p.osmId === r.osmId && pip(cx, cz, p.pts, ox / 100, oz / 100))) unmatched++;
        }
        holeArea += Math.abs(a) / 2 / 1e4;
      }
    }
  }
  console.log(`holes: ${holes} kind-6 records, ${(holeArea / 1e6).toFixed(3)} km² of courtyards (unparented ${unparented}, not inside a same-osmId parent ring ${unmatched}, < ${MIN_HOLE} m² ${small})`);
  assert.ok(holes > 30, `${holes} hole records — multipolygon inner rings are being dropped again?`);
  assert.equal(unparented, 0, 'hole records without a same-osmId building record in the same tile');
  assert.equal(unmatched, 0, 'hole centroids outside every same-osmId parent ring — wrong tile or wrong parent id');
  assert.equal(small, 0, `hole records below the ${MIN_HOLE} m² courtyard threshold (citygen would ignore them)`);
});

// per-pack roof analysis, shared across the mesh tests (buildWorld ≈ 3 s for grodno)
const analyzeRoofs = async (rel) => {
  const E = await engine();
  const P = await openPack(rel);
  const W = await E.buildWorld(P);
  const M = E.M;
  // roof types: 2 LODs switching at BLOD0, every vertex M.ROCK (walls carry plaster + rock bays)
  const allRock = (m) => { const b = new Uint8Array(m.vb); for (let v = 0; v < m.nv; v++) if (b[v * 20 + 16] !== M.ROCK) return false; return true; };
  const roofTy = [];
  W.types.forEach((T, ti) => {
    if (T.lods.length !== 2 || T.d[0] !== BLOD0) return;
    const far = W.meshes[T.lods[1]];
    if (allRock(far)) roofTy.push({ T, ti, far });
  });
  // per tile: expected roof area + rings for the centroid sweep
  const tiles = new Map(); // "tx,tz" → { want, outers: [{ bbox, pts, holes: [{ bbox, pts }] }], holesAll: [{ bbox, pts }] }
  const bboxOf = (pts, ox, oz) => {
    let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
    for (let k = 0; k < pts.length; k += 2) { const x = ox + pts[k] / 100, z = oz + pts[k + 1] / 100; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    return [x0, z0, x1, z1];
  };
  for (const [tx, tz] of P.h.tiles) {
    const T = await E.mpkTile(P, P.h.tiles.findIndex(([x, z]) => x === tx && z === tz));
    const ox = tx * S * 100, oz = tz * S * 100; // cm
    const holeRecs = [];
    const buildings = [];
    for (const layers of T.lods) for (const L of layers) {
      if (L.kind === 6) for (const r of L.recs) holeRecs.push(r);
      else if (L.kind === 1) for (const r of L.recs) buildings.push(r);
    }
    // citygen's hole-acceptance rule: ≥ 3 pts, ≥ 20 m², area centroid inside THIS outer ring
    const validHole = (hr, bpts) => {
      const n = hr.pts.length / 2;
      if (n < 3) return null;
      const a = shoelace(hr.pts, ox, oz);
      if (Math.abs(a) / 2 / 1e4 < MIN_HOLE) return null;
      let cx = 0, cz = 0;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n, cr = (ox + hr.pts[i * 2]) * (oz + hr.pts[j * 2 + 1]) - (ox + hr.pts[j * 2]) * (oz + hr.pts[i * 2 + 1]); cx += (ox + hr.pts[i * 2] + ox + hr.pts[j * 2]) * cr; cz += (oz + hr.pts[i * 2 + 1] + oz + hr.pts[j * 2 + 1]) * cr; }
      cx = cx / (3 * a) / 100; cz = cz / (3 * a) / 100; // m
      if (!pip(cx, cz, bpts, ox / 100, oz / 100)) return null;
      return { bbox: bboxOf(hr.pts, ox / 100, oz / 100), pts: hr.pts, ox, oz, area: Math.abs(a) / 2 / 1e4 };
    };
    const e = { want: 0, outers: [], holesAll: [] };
    for (const r of buildings) {
      const n = r.pts.length / 2;
      if (n < 2) continue; // citygen returns on < 2 pts
      const bb = bboxOf(r.pts, ox / 100, oz / 100);
      if (bb[2] - bb[0] < 0.1 || bb[3] - bb[1] < 0.1) continue; // citygen's bbox-span rule
      const base = r.base10 / 10, top = base + r.h10 / 10;
      if (top - base < 0.1) continue;
      const area = Math.abs(shoelace(r.pts, ox, oz)) / 2 / 1e4;
      let holeArea = 0;
      const holes = [];
      if (r.src & 16) for (const hr of holeRecs) { // only relation-provenance buildings receive holes
        const h = validHole(hr, r.pts);
        if (h) { holeArea += h.area; holes.push(h); e.holesAll.push(h); }
      }
      e.want += Math.max(0, area - holeArea);
      e.outers.push({ bbox: bb, pts: r.pts, ox, oz, holes });
    }
    tiles.set(tx + ',' + tz, e);
  }
  // per tile: far-roof mesh area + triangle centroids (world metres, identity instance transform)
  const perTile = new Map();
  const sweep = { tris: 0, outside: 0, inHole: 0, slivers: 0, worst: null };
  const IF = new Float32Array(W.inst), IU = new Uint32Array(W.inst);
  const instOf = new Map();
  for (let i = 0; i < W.nI; i++) { const ty = IU[i * 12 + 9]; if (!instOf.has(ty)) instOf.set(ty, i * 12); }
  for (const { T, ti, far } of roofTy) {
    const o = instOf.get(ti), tcx = IF[o], tcz = IF[o + 2];
    const tx = Math.round((tcx - S / 2) / S), tz = Math.round((tcz - S / 2) / S);
    const e = tiles.get(tx + ',' + tz);
    const f = new Float32Array(far.vb);
    let area = 0;
    for (let t = 0; t < far.ib.length; t += 3) {
      const a = far.ib[t] * 5, b = far.ib[t + 1] * 5, c = far.ib[t + 2] * 5;
      const ux = f[b] - f[a], uz = f[b + 2] - f[a + 2], vx = f[c] - f[a], vz = f[c + 2] - f[a + 2];
      const ta = Math.abs(ux * vz - uz * vx) / 2; // this triangle's planar area
      area += ta;
      if (!e) continue;
      // centroid in world metres (roof instances sit at the tile centre, identity rotation, scale 1)
      const cx = tcx + (f[a] + f[b] + f[c]) / 3, cz = tcz + (f[a + 2] + f[b + 2] + f[c + 2]) / 3;
      sweep.tris++;
      if (ta < DEGEN) { sweep.slivers++; continue; } // invisible numeric-fallback slivers: counted, not checked
      let inSome = false;
      for (const o2 of e.outers) {
        const [x0, z0, x1, z1] = o2.bbox;
        if (cx < x0 || cx > x1 || cz < z0 || cz > z1) continue;
        if (pip(cx, cz, o2.pts, o2.ox / 100, o2.oz / 100)) { inSome = true; break; }
      }
      if (!inSome) { sweep.outside++; if (!sweep.worst) sweep.worst = { tile: `${tx},${tz}`, cx: cx.toFixed(1), cz: cz.toFixed(1) }; }
      for (const h of e.holesAll) {
        const [x0, z0, x1, z1] = h.bbox;
        if (cx < x0 || cx > x1 || cz < z0 || cz > z1) continue;
        if (pip(cx, cz, h.pts, h.ox / 100, h.oz / 100)) sweep.inHole++;
      }
    }
    const k = tx + ',' + tz;
    const cur = perTile.get(k) || [0, 0];
    cur[0] += area; cur[1]++;
    perTile.set(k, cur);
  }
  return { E, P, W, tiles, perTile, sweep, roofTy };
};

const grodno = analyzeRoofs('packs/grodno.mpk');
const sample = analyzeRoofs('packs/sample.mpk');
const packs = [['grodno', grodno], ['sample', sample]];

test('roof area: far-roof meshes ≈ Σ(outer − hole) per tile and per pack (±15%)', async () => {
  for (const [name, pr] of packs) {
    const { tiles, perTile } = await pr;
    let wantAll = 0, meshAll = 0, worst = null;
    for (const [k, e] of tiles) {
      const [mesh, types] = perTile.get(k) || [0, 0];
      wantAll += e.want; meshAll += mesh;
      const d = mesh - e.want, tol = 0.15 * e.want + 5; // +5 m² floor: collinear/degenerate slivers
      if (Math.abs(d) > tol && (!worst || Math.abs(d) > Math.abs(worst.d))) worst = { k, mesh, want: e.want, d, types };
    }
    console.log(`roof-area ${name}: far-roof mesh ${(meshAll / 1e6).toFixed(3)} km² vs expected ${(wantAll / 1e6).toFixed(3)} km² ` +
      `(${(100 * (meshAll - wantAll) / (wantAll || 1)).toFixed(2)}%) across ${tiles.size} tiles`);
    if (worst) console.log(`roof-area ${name}: worst tile ${worst.k}: mesh ${(worst.mesh / 1e4).toFixed(0)} m² vs expected ${(worst.want / 1e4).toFixed(0)} m² (${worst.types} roof buckets)`);
    assert.ok(Math.abs(meshAll - wantAll) <= 0.15 * wantAll,
      `${name}: far-roof mesh ${(meshAll / 1e6).toFixed(3)} km² vs expected ${(wantAll / 1e6).toFixed(3)} km² — holes ignored or slab spill`);
    assert.equal(worst, null, `${name}: tile ${worst?.k} roof mesh off budget: ${(worst?.mesh / 1e4).toFixed(0)} m² vs ${(worst?.want / 1e4).toFixed(0)} m² expected`);
  }
});

test('roof geometry: every far-roof triangle centroid inside some building ring and inside NO hole', async (t) => {
  for (const [name, pr] of packs) {
    const { sweep } = await pr;
    console.log(`roof-sweep ${name}: ${sweep.tris} far-roof triangles (slivers exempt ${sweep.slivers}), outside every building ${sweep.outside}, inside a hole ${sweep.inHole}`);
    assert.equal(sweep.inHole, 0, `${name}: ${sweep.inHole} roof triangles reach into a courtyard hole — holes are not being carved (the giant-slab bug)`);
    assert.equal(sweep.outside, 0, `${name}: ${sweep.outside} roof triangles outside every building ring — slab spill` +
      (sweep.worst ? ` (first: tile ${sweep.worst.tile} at ${sweep.worst.cx}, ${sweep.worst.cz})` : ''));
  }
});
