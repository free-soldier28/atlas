// Pedestrian crossings from OSM: a way tagged crossing=* is usually a short footway whose
// centre crosses a drivable road. Find that crossing point, keep the road's heading and width,
// and hand the result to the pack header — the renderer paints zebra bars there. Pure functions.

const CELL = 64;
const cellKey = (i, j) => i + ',' + j;

const intersect = (ax, az, bx, bz, cx, cz, dx, dz) => {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  if (d1 * d2 >= 0 || d3 * d4 >= 0) return null;
  const t = d1 / (d1 - d2);
  return [ax + (bx - ax) * t, az + (bz - az) * t];
};

const kindOf = (tag) => {
  if (tag === 'no' || tag === 'island') return -1;
  if (tag === 'zebra' || tag === 'marked' || tag === 'yes') return 0;
  if (tag === 'unmarked') return 2;
  return 1; // traffic_signals, uncontrolled and untyped mapped crossings
};

export const collectCrossings = (crossingWays, drivableWays) => {
  const grid = new Map();
  for (const w of drivableWays) {
    if (!w.pts || w.pts.length < 4) continue;
    for (let k = 0; k + 3 < w.pts.length; k += 2) {
      const ax = w.pts[k], az = w.pts[k + 1], bx = w.pts[k + 2], bz = w.pts[k + 3];
      const seg = [ax, az, bx, bz, w.cls, w.width || 8];
      const i0 = Math.floor(Math.min(ax, bx) / CELL), i1 = Math.floor(Math.max(ax, bx) / CELL);
      const j0 = Math.floor(Math.min(az, bz) / CELL), j1 = Math.floor(Math.max(az, bz) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const key = cellKey(i, j); let a = grid.get(key);
        if (!a) grid.set(key, a = []);
        a.push(seg);
      }
    }
  }
  const out = [];
  const add = (s, p, kind) => {
    if (out.some((c) => Math.hypot(c.x - p[0], c.z - p[1]) < 2)) return;
    out.push({ x: Math.round(p[0] * 100) / 100, z: Math.round(p[1] * 100) / 100,
      a: Math.round(Math.atan2(s[3] - s[1], s[2] - s[0]) * 1e3) / 1e3,
      w: Math.round(s[5] * 10) / 10, k: kind });
  };
  for (const w of crossingWays) {
    const kind = kindOf(w.crossing);
    if (kind < 0 || !w.pts || w.pts.length < 4) continue;
    let hits = 0;
    for (let k = 0; k + 3 < w.pts.length; k += 2) {
      const ax = w.pts[k], az = w.pts[k + 1], bx = w.pts[k + 2], bz = w.pts[k + 3];
      const i0 = Math.floor(Math.min(ax, bx) / CELL), i1 = Math.floor(Math.max(ax, bx) / CELL);
      const j0 = Math.floor(Math.min(az, bz) / CELL), j1 = Math.floor(Math.max(az, bz) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        for (const s of grid.get(cellKey(i, j)) || []) {
          const p = intersect(ax, az, bx, bz, s[0], s[1], s[2], s[3]);
          if (!p) continue;
          add(s, p, kind); hits++;
        }
      }
    }
    if (hits) continue;
    // mappers usually cut the footway at the kerb, so its ends only TOUCH the road centreline:
    // snap each end to the nearest road segment within 5 m instead of demanding an intersection
    for (const [ex, ez] of [[w.pts[0], w.pts[1]], [w.pts[w.pts.length - 2], w.pts[w.pts.length - 1]]]) {
      const i0 = Math.floor((ex - 5) / CELL), i1 = Math.floor((ex + 5) / CELL);
      const j0 = Math.floor((ez - 5) / CELL), j1 = Math.floor((ez + 5) / CELL);
      let best = null, bd = 25;
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const s of grid.get(cellKey(i, j)) || []) {
        const dx = s[2] - s[0], dz = s[3] - s[1], t = Math.max(0, Math.min(1, ((ex - s[0]) * dx + (ez - s[1]) * dz) / (dx * dx + dz * dz || 1)));
        const px = s[0] + dx * t, pz = s[1] + dz * t, d2 = (px - ex) ** 2 + (pz - ez) ** 2;
        if (d2 < bd) { bd = d2; best = [s, [px, pz]]; }
      }
      if (best) add(best[0], best[1], kind);
    }
  }
  return out;
};
