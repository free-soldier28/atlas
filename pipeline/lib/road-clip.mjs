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
