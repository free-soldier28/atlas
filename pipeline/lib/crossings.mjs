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
      const seg = [ax, az, bx, bz, w.cls, w.width || 8, w.osmId || 0, w.nodeIds || null];
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
  const add = (s, p, kind, heading) => {
    // two OSM footways ending at the same junction often describe the SAME zebra; merge them
    if (out.some((c) => Math.hypot(c.x - p[0], c.z - p[1]) < (c.road === s[6] ? 25 : 2))) return;
    out.push({ x: Math.round(p[0] * 100) / 100, z: Math.round(p[1] * 100) / 100,
      a: Math.round((heading === undefined ? Math.atan2(s[3] - s[1], s[2] - s[0]) : heading) * 1e3) / 1e3,
      w: Math.round(s[5] * 10) / 10, k: kind, road: s[6] });
  };
  for (const w of crossingWays) {
    const kind = kindOf(w.crossing);
    if (kind < 0 || !w.pts || w.pts.length < 4) continue;
    const n = w.pts.length / 2, mid = [w.pts[n * 2 - 2] + w.pts[0], w.pts[n * 2 - 1] + w.pts[1]].map((v) => v / 2);
    const cand = []; // one crossing per tagged way — the footway's two ends are the SAME crossing
    for (let k = 0; k + 3 < w.pts.length; k += 2) {
      const ax = w.pts[k], az = w.pts[k + 1], bx = w.pts[k + 2], bz = w.pts[k + 3];
      const i0 = Math.floor(Math.min(ax, bx) / CELL), i1 = Math.floor(Math.max(ax, bx) / CELL);
      const j0 = Math.floor(Math.min(az, bz) / CELL), j1 = Math.floor(Math.max(az, bz) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        for (const s of grid.get(cellKey(i, j)) || []) {
          const p = intersect(ax, az, bx, bz, s[0], s[1], s[2], s[3]);
          if (p) cand.push({ s, p, heading: Math.atan2(bz - az, bx - ax) + Math.PI / 2,
            score: -10 + Math.hypot(p[0] - mid[0], p[1] - mid[1]) / 20 });
        }
      }
    }
    if (!cand.length) {
      // mappers cut footways at the kerb, so their ends only TOUCH the road centreline. Snap the
      // nearest road segment — but prefer one the pedestrians actually cross at ~90°. Taking the
      // closest segment alone snaps a footway running ALONG a street to that street, painting the
      // zebra parallel to the traffic instead of across it.
      for (const atEnd of [false, true]) {
        const ex = atEnd ? w.pts[n * 2 - 2] : w.pts[0], ez = atEnd ? w.pts[n * 2 - 1] : w.pts[1];
        const fx = atEnd ? w.pts[n * 2 - 2] - w.pts[n * 2 - 4] : w.pts[2] - w.pts[0];
        const fz = atEnd ? w.pts[n * 2 - 1] - w.pts[n * 2 - 3] : w.pts[3] - w.pts[1];
        const fl = Math.hypot(fx, fz) || 1;
        const i0 = Math.floor((ex - 14) / CELL), i1 = Math.floor((ex + 14) / CELL);
        const j0 = Math.floor((ez - 14) / CELL), j1 = Math.floor((ez + 14) / CELL);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const s of grid.get(cellKey(i, j)) || []) {
          const dx = s[2] - s[0], dz = s[3] - s[1], dl = Math.hypot(dx, dz) || 1;
          const t = Math.max(0, Math.min(1, ((ex - s[0]) * dx + (ez - s[1]) * dz) / (dl * dl)));
          const px = s[0] + dx * t, pz = s[1] + dz * t, d = Math.hypot(px - ex, pz - ez);
          if (d > s[5] / 2 + 2) continue; // kerb-to-centreline depends on road width, not a flat 5 m
          const sin = Math.abs(dx * fz - dz * fx) / (dl * fl); // 1 = footway ⟂ road
          if (sin < .7) continue; // a parallel footway is NOT a crossing — never paint a zebra there
          // mappers often make the footway END ON a node of the road way: that shared node identifies
          // the crossed road at a junction far more reliably than distance to nearby side streets.
          const shared = !!(w.nodeIds && s[7] && w.nodeIds.some((id) => s[7].includes(id)));
          cand.push({ s, p: [px, pz], shared, heading: Math.atan2(fz, fx) + Math.PI / 2,
            score: (1 - sin) * 8 + d / 5 + (s[4] || 9) * .05 - (shared ? 20 : 0) });
        }
      }
      const shared = cand.filter((c) => c.shared);
      if (shared.length) cand.splice(0, cand.length, ...shared);
    }
    if (cand.length) {
      cand.sort((a, b) => a.score - b.score);
      add(cand[0].s, cand[0].p, kind, cand[0].heading);
    }
  }
  return out;
};
