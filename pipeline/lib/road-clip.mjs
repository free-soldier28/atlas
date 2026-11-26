// Untagged footways may cross a carriageway without being mapped as a crossing. The renderer lifts
// footway ribbons above asphalt, so those pieces read as pale bands lying ON the road. Cut the
// piece inside the road corridor (keep both approaches) instead of painting a marking OSM lacks.
// Only near-perpendicular contacts are cut: sidewalks running ALONG a road must survive.
const CELL = 32;
const key = (i, j) => i + ',' + j;

// a footway left shorter than this after road/ramp clipping is an orphan stub — it must be dropped,
// not shipped as a white rectangle in the grass. Tagged crossings stay whole across the carriageway.
export const SHORT_FOOTWAY_M = 12;
export const footwayStub = (r, min = SHORT_FOOTWAY_M) => {
  if (r.cls < 8 || (r.flags & 2) || r.isCrossing || !r.pts || !(r.flags & 4)) return false;
  let L = 0;
  for (let k = 2; k < r.pts.length; k += 2) L += Math.hypot(r.pts[k] - r.pts[k - 2], r.pts[k + 1] - r.pts[k - 1]) / 100;
  return L < min;
};

export const makeRoadIndex = (roads) => {
  const cells = new Map();
  for (const r of roads) {
    if (r.cls > 7 || !r.pts || r.pts.length < 4) continue;
    for (let k = 0; k + 3 < r.pts.length; k += 2) {
      const ax = r.pts[k], az = r.pts[k + 1], bx = r.pts[k + 2], bz = r.pts[k + 3];
      const hw = (r.width || 8) / 2 + 3; // include the kerb, where mappers end the footway
      const s = [ax, az, bx, bz, hw];
      const i0 = Math.floor((Math.min(ax, bx) - hw) / CELL), i1 = Math.floor((Math.max(ax, bx) + hw) / CELL);
      const j0 = Math.floor((Math.min(az, bz) - hw) / CELL), j1 = Math.floor((Math.max(az, bz) + hw) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k2 = key(i, j); let a = cells.get(k2); if (!a) cells.set(k2, a = []); a.push(s);
      }
    }
  }
  return cells;
};

const inside = (cells, x, z, fx, fz, fl) => {
  for (const s of cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || []) {
    const dx = s[2] - s[0], dz = s[3] - s[1], dl = Math.hypot(dx, dz) || 1;
    if (Math.abs(dx * fz - dz * fx) / (dl * fl) < .5) continue; // parallel: a sidewalk, not a crossing
    const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / (dl * dl)));
    if (Math.hypot(x - s[0] - dx * t, z - s[1] - dz * t) <= s[4]) return true;
  }
  return false;
};

// flat [x,z,…] runs of the footway OUTSIDE roads. `step` densifies so a 2-point way spanning a
// carriageway is seen; returns null when nothing was cut.
export const footwayRoadRuns = (pts, cells, { step = 3 } = {}) => {
  const mark = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
    const fx = bx - ax, fz = bz - az, fl = Math.hypot(fx, fz) || 1;
    const n = Math.max(1, Math.ceil(fl / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = ax + fx * t, z = az + fz * t;
      mark.push([x, z, inside(cells, x, z, fx, fz, fl)]);
    }
  }
  if (!mark.some((m) => m[2])) return null;
  const runs = []; let cur = [];
  for (const [x, z, wet] of mark) {
    if (wet) { if (cur.length >= 4) runs.push(cur); cur = []; continue; }
    const n = cur.length;
    if (n >= 2 && Math.abs(cur[n - 2] - x) < .01 && Math.abs(cur[n - 1] - z) < .01) continue;
    cur.push(x, z);
  }
  if (cur.length >= 4) runs.push(cur);
  return runs;
};

// A path that skirts a building and then lies along the carriageway paints pale over asphalt
// (footways are deliberately lifted above the road mesh). Ordinary sidewalks are fine; only cut a
// footway that is BOTH building-adjacent and mostly inside a road corridor.
const pip = (x, z, p) => {
  let hit = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2)
    if ((p[i + 1] > z) !== (p[j + 1] > z) && x < (p[j] - p[i]) * (z - p[i + 1]) / (p[j + 1] - p[i + 1]) + p[i]) hit = !hit;
  return hit;
};
const nearRing = (x, z, p, margin) => {
  if (pip(x, z, p)) return true;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const ax = p[j], az = p[j + 1], bx = p[i], bz = p[i + 1];
    const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x - ax - dx * t, z - az - dz * t) <= margin) return true;
  }
  return false;
};

export const makeFootprintIndex = (buildings) => {
  const cells = new Map();
  for (const b of buildings) {
    const p = b.pts; if (!p || p.length < 6) continue;
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let k = 0; k < p.length; k += 2) {
      x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]); z0 = Math.min(z0, p[k + 1]); z1 = Math.max(z1, p[k + 1]);
    }
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
        const k = key(i, j); let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(p);
      }
  }
  return cells;
};

const samplesOf = (pts, step) => {
  const out = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 0; k <= n; k++) out.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
  }
  return out;
};

export const footwayNearBuilding = (pts, index, { step = 3, margin = 1 } = {}) => {
  for (const [x, z] of samplesOf(pts, step))
    for (const p of index.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || [])
      if (nearRing(x, z, p, margin)) return true;
  return false;
};

export const footwayOnRoad = (pts, cells, { step = 3, margin = .5 } = {}) => {
  const s = samplesOf(pts, step);
  let wet = 0;
  for (const [x, z] of s) for (const seg of cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || []) {
    const dx = seg[2] - seg[0], dz = seg[3] - seg[1], dl = Math.hypot(dx, dz) || 1;
    const t = Math.max(0, Math.min(1, ((x - seg[0]) * dx + (z - seg[1]) * dz) / (dl * dl)));
    if (Math.hypot(x - seg[0] - dx * t, z - seg[1] - dz * t) <= seg[4] + margin) { wet++; break; }
  }
  return s.length ? wet / s.length : 0;
};

// angle-agnostic cut: returns the dry runs of a building-adjacent footway.
export const footwayOnRoadRuns = (pts, cells, { step = 3, margin = .5 } = {}) => {
  const mark = samplesOf(pts, step).map(([x, z]) => {
    for (const seg of cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || []) {
      const dx = seg[2] - seg[0], dz = seg[3] - seg[1], dl = Math.hypot(dx, dz) || 1;
      const t = Math.max(0, Math.min(1, ((x - seg[0]) * dx + (z - seg[1]) * dz) / (dl * dl)));
      if (Math.hypot(x - seg[0] - dx * t, z - seg[1] - dz * t) <= seg[4] + margin) return [x, z, true];
    }
    return [x, z, false];
  });
  if (!mark.some((m) => m[2])) return null;
  const runs = []; let cur = [];
  for (const [x, z, wet] of mark) {
    if (wet) { if (cur.length >= 4) runs.push(cur); cur = []; continue; }
    const n = cur.length;
    if (n >= 2 && Math.abs(cur[n - 2] - x) < .01 && Math.abs(cur[n - 1] - z) < .01) continue;
    cur.push(x, z);
  }
  if (cur.length >= 4) runs.push(cur);
  return runs;
};
