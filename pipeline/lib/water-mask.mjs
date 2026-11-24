// Water visibility mask: polygons (accurate riverbanks) plus widened centreline ribbons (the
// fallback water surface). Both buildings and roads must be checked against BOTH — a 55 m river
// ribbon alone used to drown houses and footways even though every polygon test passed.
// Pure functions over flat [x,z,...] arrays in one shared metric frame; grid-indexed so 33k road
// records × 228 lines stays cheap.

const CELL = 100; // m — spatial bucket for water geometry
const ck = (cx, cz) => cx + ',' + cz;
// a footprint with a third of its sampled points in visible water is a house standing in the
// stream — the renderer must not draw the river through its walls
export const WET_BUILDING = 0.35;

const pip = (x, z, p) => {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const z1 = p[i + 1], z2 = p[j + 1];
    if ((z1 > z) !== (z2 > z) && x < (p[j] - p[i]) * (z - z1) / (z2 - z1) + p[i]) inside = !inside;
  }
  return inside;
};
const distSeg = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
};

export const makeMask = (polys, lines) => {
  const cells = new Map();
  const add = (x0, z0, x1, z1, item) => {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = ck(cx, cz); let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(item);
      }
  };
  const P = [], L = [];
  for (const w of polys) {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let i = 0; i < w.pts.length; i += 2) { x0 = Math.min(x0, w.pts[i]); x1 = Math.max(x1, w.pts[i]); z0 = Math.min(z0, w.pts[i + 1]); z1 = Math.max(z1, w.pts[i + 1]); }
    const p = { pts: w.pts, area: Math.abs(w.area), big: Math.abs(w.area) >= 2000, x0, z0, x1, z1 };
    P.push(p); add(x0, z0, x1, z1, p);
  }
  for (const l of lines) {
    for (let i = 0; i + 3 < l.pts.length; i += 2) {
      // a 12 m river ribbon is a real river: a road crossing it needs a deck, just like a lake.
      // 4 m streams (hw 2) stay small — footpaths may step over those.
      const s = { seg: true, pts: [l.pts[i], l.pts[i + 1], l.pts[i + 2], l.pts[i + 3]], hw: l.hw, big: l.hw >= 6 };
      L.push(s);
      add(Math.min(s.pts[0], s.pts[2]) - l.hw, Math.min(s.pts[1], s.pts[3]) - l.hw,
        Math.max(s.pts[0], s.pts[2]) + l.hw, Math.max(s.pts[1], s.pts[3]) + l.hw, s);
    }
  }
  return { cells, polys: P, segments: L };
};

const near = (mask, x, z) => mask.cells.get(ck(Math.floor(x / CELL), Math.floor(z / CELL))) || [];

export const inWater = (mask, x, z, margin = 0) => {
  for (const p of near(mask, x, z, margin)) {
    if (p.seg) { // segment
      if (distSeg(x, z, p.pts[0], p.pts[1], p.pts[2], p.pts[3]) <= p.hw + margin) return true;
    } else if (x >= p.x0 - margin && x <= p.x1 + margin && z >= p.z0 - margin && z <= p.z1 + margin) {
      if (pip(x, z, p.pts)) return true;
      // a way running exactly on the bank is boundary-noise: a small margin settles the PIP tie
      if (margin > 0) for (let i = 0, j = p.pts.length - 2; i < p.pts.length; j = i, i += 2)
        if (distSeg(x, z, p.pts[j], p.pts[j + 1], p.pts[i], p.pts[i + 1]) <= margin) return true;
    }
  }
  return false;
};

// fraction of a footprint's sampled points (vertices + centroid) that fall in water
export const submerged = (mask, pts, margin = 0) => {
  let wet = 0, n = 0, cx = 0, cz = 0;
  for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cz += pts[i + 1]; n++; }
  cx /= n; cz /= n;
  for (let i = 0; i < pts.length; i += 2) if (inWater(mask, pts[i], pts[i + 1], margin)) wet++;
  if (inWater(mask, cx, cz, margin)) wet++;
  return (wet + 1) / (n + 1);
};

// does this way actually cross BIG water (a lake/river poly or a wide river ribbon)?
export const crossesBig = (mask, pts, margin = 0) => {
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 8));
    for (let k = 0; k <= n; k++) {
      const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n;
      if (!inWater(mask, x, z, margin)) continue;
      for (const p of near(mask, x, z)) {
        if (!p.big) continue;
        if (p.seg && distSeg(x, z, p.pts[0], p.pts[1], p.pts[2], p.pts[3]) <= p.hw + margin) return true;
        if (!p.seg && pip(x, z, p.pts)) return true;
      }
    }
  }
  return false;
};
