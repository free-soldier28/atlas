// the world: which meshes exist and where every instance stands — built from the map pack (PK).
// One merged mesh per tile per layer kind (chunked static geometry); buildings go through citygen's
// tint buckets and LODs; the ground is one plane over the pack.
const K = { SOLID: 0, LEAF: 1, CRYSTAL: 2, GLASS: 3, WATER: 4, CASCADE: 5 };
// flags: not in the camera cascade / mirror / any shadow map / baked shadows (moving things); never culled; drawn
// last (ground); thin crystal, drawn after the solid crystals so they show through
const NO_NEAR = 1, NO_MIRROR = 2, NO_SHADOW = 4, NO_BAKE = 8, ALWAYS = 16, DRAW_LAST = 32, THIN = 64;
const Q0 = [0, 0, 0, 1];

// road class → full width in metres when the record's w10 is 0 (docs/mpk-format.md)
const CLSW = [30, 24, 18, 14, 11, 8, 6.5, 5, 4, 2, 1.5];
// water line kinds → full width in metres (centrelines widened into ribbons; docs/mpk-format.md)
const WW = { 8: 12, 9: 4, 10: 12 }; // keep in sync with pipeline/build-city.mjs WWIDTH

async function buildWorld(PK) { // async: tiles and the graph inflate on demand
  const meshes = [], types = [], labels = [];
  const emptyMesh = () => new MB(1).build(); // zero-vertex far LOD: windows vanish before the far distance
  let IB = new ArrayBuffer(48 << 14), IF = new Float32Array(IB), IU = new Uint32Array(IB), nI = 0;
  // up to four LODs switched at d01, d12, d23, gone beyond dmax; thin > 0: distance where instances start thinning out
  const type = (lods, kind, d01 = 1e9, d12 = 1e9, dmax = 1e9, thin = 0, flags = 0, d23 = 1e9) => { types.push({ lods: lods.map((m) => meshes.push(m) - 1), kind, d: [d01, d12, dmax, thin], d23, flags, n: 0 }); return types.length - 1; };
  const put = (ty, x, y, z, s = 1, q = Q0, tint = 0xffffffff, sy = 1) => {
    if ((nI + 1) * 48 > IB.byteLength) { const n = new ArrayBuffer(IB.byteLength * 2); new Uint8Array(n).set(new Uint8Array(IB)); IB = n; IF = new Float32Array(n); IU = new Uint32Array(n); }
    const o = nI++ * 12; IF[o] = x; IF[o + 1] = y; IF[o + 2] = z; IF[o + 3] = s; IF[o + 4] = q[0]; IF[o + 5] = q[1]; IF[o + 6] = q[2]; IF[o + 7] = q[3];
    IU[o + 8] = tint; IU[o + 9] = ty; IF[o + 10] = types[ty].flags & ALWAYS ? 1e6 : meshes[types[ty].lods[0]].rad * s * max(1, sy); IF[o + 11] = sy; types[ty].n++;
  };

  // ground masks, 1 m/texel over +-1024 m: MAP all neutral, LANDMAP flat grass. Green layers darken the grass
  // to park green; roads store their dark asphalt (r would need > .5 for ground()'s paving — the ribbon meshes
  // carry the look until the ground shader learns pack colours).
  const MAP = new Uint8Array(2048 * 2048 * 4), LANDMAP = new Uint8Array(2048 * 2048 * 4);
  for (let j = 0; j < 2048; j++) for (let i = 0; i < 2048; i++) { const o = (j * 2048 + i) * 4; LANDMAP[o] = 140; LANDMAP[o + 1] = 162; LANDMAP[o + 2] = 115; LANDMAP[o + 3] = 255; }
  // one ribbon rectangle of a road into MAP: dark asphalt (40, 40, 45)
  const paintSeg = (x0, z0, x1, z1, hw) => {
    const ex = x1 - x0, ez = z1 - z0, L = hypot(ex, ez); if (L < 1e-6) return;
    const ux = ex / L, uz = ez / L, nx = uz, nz = -ux;
    const i0 = max(0, floor(min(x0, x1) - hw) + 1024), i1 = min(2047, ceil(max(x0, x1) + hw) + 1024);
    const j0 = max(0, floor(min(z0, z1) - hw) + 1024), j1 = min(2047, ceil(max(z0, z1) + hw) + 1024);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = i + 0.5 - 1024 - x0, pz = j + 0.5 - 1024 - z0, s = px * ux + pz * uz;
      if (s < -0.5 || s > L + 0.5 || abs(px * nx + pz * nz) > hw) continue;
      const o = (j * 2048 + i) * 4; MAP[o] = 40; MAP[o + 1] = 40; MAP[o + 2] = 45;
    }
  };
  // a green polygon into LANDMAP: park green, per-pixel point-in-polygon (parks are small; 1 m/texel is fine)
  const paintPoly = (pts) => {
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let k = 0; k < pts.length; k += 2) { x0 = min(x0, pts[k]); x1 = max(x1, pts[k]); z0 = min(z0, pts[k + 1]); z1 = max(z1, pts[k + 1]); }
    const n = pts.length / 2;
    for (let j = max(0, floor(z0) + 1024), j1 = min(2047, ceil(z1) + 1024); j <= j1; j++) for (let i = max(0, floor(x0) + 1024), i1 = min(2047, ceil(x1) + 1024); i <= i1; i++) {
      const px = i + 0.5 - 1024, pz = j + 0.5 - 1024; let inside = false;
      for (let k = 0, m = n - 1; k < n; m = k++) {
        const xi = pts[k * 2], zi = pts[k * 2 + 1], xm = pts[m * 2], zm = pts[m * 2 + 1];
        if ((zi > pz) !== (zm > pz) && px < (xm - xi) * (pz - zi) / (zm - zi) + xi) inside = !inside;
      }
      if (inside) { const o = (j * 2048 + i) * 4; LANDMAP[o] = 60; LANDMAP[o + 1] = 120; LANDMAP[o + 2] = 60; }
    }
  };

  // pack bounds in metres: the tiles' corner span (+200 m margin for the ground plane)
  const S = PK.h.tileSize || 512;
  let tx0 = 1e9, tx1 = -1e9, tz0 = 1e9, tz1 = -1e9;
  for (const t of PK.h.tiles) { tx0 = min(tx0, t[0]); tx1 = max(tx1, t[0]); tz0 = min(tz0, t[1]); tz1 = max(tz1, t[1]); }
  const gx0 = tx0 * S - 200, gx1 = (tx1 + 1) * S + 200, gz0 = tz0 * S - 200, gz1 = (tz1 + 1) * S + 200;

  // ground: one flat plane (the pack frame is flat until terrain packs arrive), drawn last
  {
    const mb = new MB(16); mb.mat = M.GROUND;
    mb.v(gx0, 0, gz0, 0, 1, 0); mb.v(gx1, 0, gz0, 0, 1, 0); mb.v(gx1, 0, gz1, 0, 1, 0); mb.v(gx0, 0, gz1, 0, 1, 0);
    mb.tri(0, 2, 1); mb.tri(0, 3, 2);
    put(type([mb.build()], K.SOLID, 1e9, 1e9, 1e9, 0, NO_NEAR | DRAW_LAST), 0, 0, 0);
  }

  const bboxes = []; // building boxes for collision: [x0, z0, x1, z1, top] (outer box at full height)
  // roads and water lines: one continuous strip. Per-segment butt quads left wedge gaps at every
  // bend — the wider the road, the bigger the notch — so the strip now runs on per-vertex miter
  // pairs (adjacent segment normals averaged, length hw / cos of the half-angle, clamped at 4 hw):
  // both segments share the joint pair, the ribbon cannot open. Ends run half a width past their
  // last point: separate ways meet at a node with their ends apart, and the wedges between their
  // butt lines only close if both ribbons reach across the joint.
  // pts are tile-local cm; dx / dz shift the ribbon into the tile's centre-local frame.
  // y is the strip's height (metres): a constant, or a per-vertex array — bridge decks ride in
  // the record's ys (cm) with ramps at both ends, so `bridgeDeck` below can share the miter work
  const ribbonBase = (pts, dx, dz, hw) => {
    const n = pts.length / 2;
    const dirX = [], dirZ = []; // unit segment directions (degenerate segments inherit the previous)
    for (let i = 0; i + 1 < n; i++) {
      const ex = pts[i * 2 + 2] - pts[i * 2], ez = pts[i * 2 + 3] - pts[i * 2 + 1], L = hypot(ex, ez);
      dirX[i] = L < 1e-6 ? (i ? dirX[i - 1] : 1) : ex / L;
      dirZ[i] = L < 1e-6 ? (i ? dirZ[i - 1] : 0) : ez / L;
    }
    const ext = hw * .5, bx = [dx + pts[0] / 100 - dirX[0] * ext, dz + pts[1] / 100 - dirZ[0] * ext],
      ex2 = [dx + pts[pts.length - 2] / 100 + dirX[n - 2] * ext, dz + pts[pts.length - 1] / 100 + dirZ[n - 2] * ext];
    const off = new Float64Array(n * 4); // per vertex: minus-x, minus-z, plus-x, plus-z
    for (let i = 0; i < n; i++) {
      let mx, mz; // the joint's outward direction: the segment's normal at the ends, their average inside
      if (i === 0) { mx = dirZ[0]; mz = -dirX[0]; }
      else if (i === n - 1) { mx = dirZ[i - 1]; mz = -dirX[i - 1]; }
      else { mx = dirZ[i - 1] + dirZ[i]; mz = -(dirX[i - 1] + dirX[i]); const L = hypot(mx, mz);
        if (L > 1e-9) { mx /= L; mz /= L; } else { mx = dirZ[i]; mz = -dirX[i]; } }
      const seg = min(i, n - 2);
      const bxx = i === 0 ? bx[0] : i === n - 1 ? ex2[0] : dx + pts[i * 2] / 100;
      const bzz = i === 0 ? bx[1] : i === n - 1 ? ex2[1] : dz + pts[i * 2 + 1] / 100;
      const ml = min(hw / max(0.3, abs(mx * dirZ[seg] - mz * dirX[seg])), 4 * hw);
      off[i * 4] = bxx - mx * ml; off[i * 4 + 1] = bzz - mz * ml;
      off[i * 4 + 2] = bxx + mx * ml; off[i * 4 + 3] = bzz + mz * ml;
    }
    return { n, dirX, dirZ, off };
  };
  const ribbon = (mb, pts, hw, dx, dz, y = 0.06) => {
    const { n, off } = ribbonBase(pts, dx, dz, hw);
    if (n < 2) return;
    for (let i = 0; i + 1 < n; i++) {
      const y0 = y.length ? y[i] : y, y1 = y.length ? y[i + 1] : y;
      mb.quad(mb.v(off[i * 4], y0, off[i * 4 + 1], 0, 1, 0), mb.v(off[i * 4 + 2], y0, off[i * 4 + 3], 0, 1, 0),
        mb.v(off[i * 4 + 6], y1, off[i * 4 + 7], 0, 1, 0), mb.v(off[i * 4 + 4], y1, off[i * 4 + 5], 0, 1, 0));
    }
  };
  // bridge structure for a deck record (flags bit1): side walls under the deck edge, parapets on
  // top, piers down to the ground where the deck is high enough. The deck surface itself is the
  // road's own ribbon at the ys heights; everything here is the QUAY-mesh concrete that makes a
  // floating ribbon read as a bridge
  const bridgeDeck = (mb, pts, hw, dx, dz, ycm) => {
    const y = ycm.map((v) => v / 100);
    const { n, dirX, dirZ } = ribbonBase(pts, dx, dz, hw);
    if (n < 2) return;
    // vertical wall between the points (ax,az)@ay and (bx,bz)@by, hanging `drop` metres below
    // the top (clamped at the ground); both faces when the wall is seen from either side
    const wall = (ax, az, ay, bx, bz, by, nx, nz, drop = 1.3, both = true) => {
      const a0 = max(0, ay - drop), b0 = max(0, by - drop);
      if (ay <= 0.03 && a0 <= 0.03) return; // ramp already at ground level
      mb.quad(mb.v(ax, a0, az, nx, 0, nz), mb.v(bx, b0, bz, nx, 0, nz), mb.v(bx, by, bz, nx, 0, nz), mb.v(ax, ay, az, nx, 0, nz));
      if (both) mb.quad(mb.v(ax, ay, az, -nx, 0, -nz), mb.v(bx, by, bz, -nx, 0, -nz), mb.v(bx, b0, bz, -nx, 0, -nz), mb.v(ax, a0, az, -nx, 0, -nz));
    };
    for (let i = 0; i + 1 < n; i++) {
      const px = dx + pts[i * 2] / 100, pz = dz + pts[i * 2 + 1] / 100, yi = y[i];
      const qx = dx + pts[i * 2 + 2] / 100, qz = dz + pts[i * 2 + 3] / 100, yj = y[i + 1];
      const nx = dirZ[i], nz = -dirX[i]; // outward normal of this segment
      const lw = hw - 0.12, pw = hw + 0.1, ph = 1.1; // slab plane, parapet plane, parapet rise
      // deck slab sides: both faces (the deck is seen from above the water and from under it)
      wall(px + nx * lw, pz + nz * lw, yi + 0.04, qx + nx * lw, qz + nz * lw, yj + 0.04, nx, nz);
      wall(px - nx * lw, pz - nz * lw, yi + 0.04, qx - nx * lw, qz - nz * lw, yj + 0.04, -nx, -nz);
      // parapets: a 1.1 m wall just outside each deck edge + a 0.3 m top cap
      for (const s of [-1, 1]) {
        const nxs = nx * s, nzs = nz * s;
        const ax = px + nxs * pw, az = pz + nzs * pw, bx = qx + nxs * pw, bz = qz + nzs * pw;
        const cx = px + nxs * (pw + 0.3), cz = pz + nzs * (pw + 0.3), dxx = qx + nxs * (pw + 0.3), dzz = qz + nzs * (pw + 0.3);
        wall(ax, az, yi + 0.05, bx, bz, yj + 0.05, nxs, nzs, ph);
        mb.quad(mb.v(ax, yi + ph + 0.05, az, 0, 1, 0), mb.v(bx, yj + ph + 0.05, bz, 0, 1, 0), mb.v(dxx, yj + ph + 0.05, dzz, 0, 1, 0), mb.v(cx, yi + ph + 0.05, cz, 0, 1, 0));
      }
    }
    // piers: every 24 m of the run's arc, only where the deck is high enough (never on the
    // ramps / banks) — the box hangs from the slab underside down to the ground
    let acc = 0, next = 24;
    for (let i = 0; i + 1 < n; i++) {
      const sl = hypot(pts[i * 2 + 2] - pts[i * 2], pts[i * 2 + 3] - pts[i * 2 + 1]) / 100;
      while (acc + sl >= next) {
        const t = (next - acc) / sl;
        const cx = dx + pts[i * 2] / 100 + (dx + pts[i * 2 + 2] / 100 - dx - pts[i * 2] / 100) * t;
        const cz = dz + pts[i * 2 + 1] / 100 + (dz + pts[i * 2 + 3] / 100 - dz - pts[i * 2 + 1] / 100) * t;
        const yk = y[i] + (y[i + 1] - y[i]) * t;
        next += 24;
        if (yk < 2.4) continue;
        const ux = dirX[i], uz = dirZ[i], wx = -uz, wz = ux, a = 0.8, b = min(hw - 0.35, 2.6), top = yk - 1.1;
        if (top < 0.4) continue;
        // four walls of the pier box, rotated to the bridge direction
        const p1x = cx + ux * a + wx * b, p1z = cz + uz * a + wz * b, p2x = cx + ux * a - wx * b, p2z = cz + uz * a - wz * b;
        const p3x = cx - ux * a - wx * b, p3z = cz - uz * a - wz * b, p4x = cx - ux * a + wx * b, p4z = cz - uz * a + wz * b;
        wall(p1x, p1z, top, p2x, p2z, top, ux, uz, 1e9, false);
        wall(p3x, p3z, top, p4x, p4z, top, -ux, -uz, 1e9, false);
        wall(p4x, p4z, top, p1x, p1z, top, wx, wz, 1e9, false);
        wall(p2x, p2z, top, p3x, p3z, top, -wx, -wz, 1e9, false);
      }
      acc += sl;
    }
  };
  // a flat polygon triangulated by ear clipping (concave-safe, no fan spill) at height y;
  // pts already in tile-local metres. earclip's indices are pool-local: rebase onto the mesh (b0)
  const earMesh = (mb, pts, y) => {
    const { xs, zs, tris } = earclip(pts);
    const b0 = mb.nv;
    for (let i = 0; i < xs.length; i++) mb.v(xs[i], y, zs[i], 0, 1, 0);
    for (let i = 0; i < tris.length; i += 3) mb.tri(b0 + tris[i], b0 + tris[i + 1], b0 + tris[i + 2]);
  };

  // tiles: the finest LOD each carries (coarser ones arrive with country packs and streaming).
  // Every tile mesh is centre-local and its instance sits at the tile centre, so the cull pass gets a
  // ~360 m bounding radius per tile — the LOD switches and the frustum test both work per tile.
  // tile inflation is async (DecompressionStream), meshing is sync: inflate the next batch while
  // the current one is being generated, 24 streams at a time (980 sequential awaits cost ~0.45 s)
  const TB = 24;
  const prefetch = (b) => Promise.all(PK.h.tiles.slice(b, b + TB).map((_, k) => mpkTile(PK, b + k)));
  let incoming = prefetch(0);
  for (let i = 0; i < PK.h.tiles.length; i++) {
    if (i % TB === 0 && i) await incoming; // the batch we are about to mesh must be inflated
    const T = await mpkTile(PK, i), lods = T.lods[T.lods.length - 1], ox = T.x * S, oz = T.z * S, th = S / 2, tcx = ox + th, tcz = oz + th;
    // building holes (layer kind 6, docs/mpk-format.md): group by parent osmId — the matching
    // relation-provenance buildings carve their roofs with them and wall the rings (courtyards)
    let holes = null;
    for (const L of lods) if (L.kind === 6) {
      if (!holes) holes = new Map();
      for (const r of L.recs) { const a = holes.get(r.osmId); if (a) a.push(r); else holes.set(r.osmId, [r]); }
    }
    const city = cityTile(i, lods, ox, oz, S, bboxes, holes); // buildings into tint buckets + road centre lines
    const mR = new MB(1 << 15), mF = new MB(1 << 12), mW = new MB(1 << 12), mG = new MB(1 << 12), mB = new MB(1 << 13);
    mB.mat = M.QUAY; // bridge concrete: deck slab sides, parapets, piers (baked per vertex)
    let nR = 0, nW = 0, nG = 0, nB = 0;
    for (const L of lods) {
    if (L.kind === 2) {
      // two surfaces: drivable roads (cls ≤ 7) in dark asphalt, footways/paths/steps (8-10) in
      // flagstone — the class hierarchy the eye needs ("where is the road, where is the footpath")
      mR.mat = M.ASPHALT;
      for (const r of L.recs) {
        const hw = (r.w10 || (CLSW[r.cls] || 8) * 10) / 20;
        const mb = r.cls <= 7 ? mR : mF;
        mb.mat = r.cls <= 7 ? M.ASPHALT : M.PAVE;
        const bridge = !!(r.flags & 2) && r.ys;
        ribbon(mb, r.pts, hw, -th, -th, bridge ? r.ys.map((v) => v / 100) : 0.06);
        if (bridge) { bridgeDeck(mB, r.pts, hw, -th, -th, r.ys); nB++; }
        for (let k = 0; k + 3 < r.pts.length; k += 2) {
          // the ground MAP reads as asphalt where the road lies on it; elevated deck segments
          // must not tint the riverbed under the bridge
          if (bridge && (r.ys[k / 2] > 100 || r.ys[k / 2 + 1] > 100)) continue;
          paintSeg(ox + r.pts[k] / 100, oz + r.pts[k + 1] / 100, ox + r.pts[k + 2] / 100, oz + r.pts[k + 3] / 100, hw);
        }
        nR++;
      }
    } else if (L.kind === 3) {
        mW.mat = 0; mW.ea = 0; // fsWater's inland-water look (river, lake, canal, pond); the mesh is just positions
        // polygons (kinds 0-3) are closed rings → ear-clip at the water plane; lines (8-10) are open
        // centrelines → ribbons at the doc's widths (river 55 m, stream 4 m, canal 15 m)
        for (const r of L.recs) {
          if (r.kind <= 3) {
            const pts = new Float64Array(r.pts.length); for (let k = 0; k < r.pts.length; k++) pts[k] = -th + r.pts[k] / 100;
            earMesh(mW, pts, WATER); nW++;
          } else if (r.kind >= 8 && r.kind <= 10) {
            ribbon(mW, r.pts, WW[r.kind] / 2, -th, -th, WATER); nW++;
          } // kinds 4-7 (stale packs) and anything newer: skipped (forward-compatible)
        }
      } else if (L.kind === 4) {
        mG.mat = M.GROUND; // ground() ignores tint; the polys sit on the shader's lawn, LANDMAP carries the park green
        for (const r of L.recs) {
          const pts = new Float64Array(r.pts.length); for (let k = 0; k < r.pts.length; k++) pts[k] = -th + r.pts[k] / 100;
          earMesh(mG, pts, 0.03); paintPoly(Array.from(r.pts, (v, k) => (k & 1 ? oz : ox) + v / 100)); nG++;
        }
      } // kind 1 → cityTile above; kind 6 holes consumed above; kind 5 (terrain) and unknown kinds: skipped
    }
    // labels: housenumbers ride on building records (header strings), street names on road records.
    // One anchor per record; dedupe() folds repeated way names into one label per world cell.
    for (const L of lods) {
      if (L.kind === 1) for (const b of L.recs) {
        if (!b.num) continue;
        const n = b.pts.length / 2; let ax = 0, az = 0;
        for (let k = 0; k < b.pts.length; k += 2) { ax += b.pts[k]; az += b.pts[k + 1]; }
        labels.push({ x: ox + ax / n / 100, z: oz + az / n / 100, y: (b.h10 + b.base10) / 10 + 0.6,
          text: PK.h.strings[b.num] || '', kind: 0, priority: 1 });
      } else if (L.kind === 2) for (const r of L.recs) {
        if (!r.name) continue;
        let total = 0;
        for (let k = 0; k + 3 < r.pts.length; k += 2) total += hypot(r.pts[k + 2] - r.pts[k], r.pts[k + 3] - r.pts[k + 1]);
        const half = total / 2;
        let acc = 0, mx = r.pts[0], mz = r.pts[1], my = 1;
        for (let k = 0; k + 3 < r.pts.length; k += 2) {
          const sl = hypot(r.pts[k + 2] - r.pts[k], r.pts[k + 3] - r.pts[k + 1]);
          if (sl > 0 && acc + sl >= half) {
            const t = (half - acc) / sl;
            mx = r.pts[k] + (r.pts[k + 2] - r.pts[k]) * t;
            mz = r.pts[k + 1] + (r.pts[k + 3] - r.pts[k + 1]) * t;
            if (r.ys) my = r.ys[min(r.ys.length - 1, round(k / 2 + t / 2))] / 100 + 2;
            break;
          }
          acc += sl;
        }
        labels.push({ x: ox + mx / 100, z: oz + mz / 100, y: my, text: PK.h.strings[r.name] || '', kind: 1, priority: 0 });
      }
    }
    // buildings: one type per tint bucket; LODs run near → far (the cull pass switches up with distance),
    // so the facade carries slot 0, strips slot 1 and the plain prism slot 2. An empty LOD reuses its
    // neighbour (identical geometry cross-fades harmlessly). Roofs: caps near, plain ear-clip top far.
    for (const w of city.walls.values()) {
      const f = w.f.build(), mM = w.m.ni ? w.m.build() : f, mN = w.n.build();
      put(type([mN, mM, f], K.SOLID, BLOD0, BLOD1, 1e9), tcx, 0, tcz, 1, Q0, w.t);
      // windows, bays and the door live in their own kind: the settings toggle gates their draw
      // without rebuilding the world; no shadow maps (pane insets are far too small to matter)
      if (w.wn.ni || w.wm.ni) {
        // every slot must be a distinct object: the GPU upload consumes each mesh buffer once
        const wN = w.wn.build(), wM = w.wm.build();
        put(type([wN, wM, emptyMesh()], K.GLASS, BLOD0, BLOD1, 1e9, 0, NO_NEAR | NO_SHADOW | NO_BAKE), tcx, 0, tcz, 1, Q0, w.t);
      }
    }
    for (const r of city.roofs.values()) {
      const f = r.f.build(), mN = r.n.ni ? r.n.build() : f;
      put(type([mN, f], K.SOLID, BLOD0, 1e9, 1e9), tcx, 0, tcz, 1, Q0, r.t);
    }
    if (city.dash && city.dash.ni) put(type([city.dash.build()], K.SOLID, 1e9, 1e9, 380), tcx, 0, tcz, 1, Q0, rgb(1, 1, .96));
    // only register meshes that got geometry (degenerate records — e.g. a pack's zeroed road pts — make none)
    if (nR && mR.ni) put(type([mR.build()], K.SOLID, 1e9, 1e9, 1e9), tcx, 0, tcz);
    if (nR && mF.ni) put(type([mF.build()], K.SOLID, 1e9, 1e9, 1e9), tcx, 0, tcz);
    if (nB && mB.ni) put(type([mB.build()], K.SOLID, 1e9, 1e9, 1e9), tcx, 0, tcz); // bridge concrete
    if (nW && mW.ni) put(type([mW.build()], K.WATER, 1e9, 1e9, 1e9), tcx, 0, tcz);
    if (nG && mG.ni) put(type([mG.build()], K.SOLID, 1e9, 1e9, 1e9), tcx, 0, tcz);
    if ((i + 1) % TB === 0 && i + 1 < PK.h.tiles.length) incoming = prefetch(i + 1);
  }

  // routing graph, decoded once here (GPS walks it later); absent in country packs
  PK.graph = await mpkGraph(PK);

  const hard = { domes: [], halls: [], villas: [], shapes: [] }; // Atlantis shapes are gone; boxes rule now
  // type/put: the same closures, exposed so gps.js can add the vehicle marker after the build
  return { meshes, types, inst: IB.slice(0, nI * 48), nI, MAP, LANDMAP, ground: () => 0, hard, bboxes, type, put,
    labels: dedupe(labels), strings: PK.h.strings || [] };
}
