// A bridge deck sweeps an elevated corridor through the bank. An OSM building whose footprint
// sticks through that corridor is bad data (the mapped bridge way often includes its ramps into
// the shore): it must be dropped before packing, and QA must fail any pack that still ships one.
// Pure functions, world metres; used by build-city.mjs (fix) and qa.mjs (guard).

export const makeDeck = (p, ys, hw, cls = 0) => {
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9, len = 0;
  for (let k = 0; k < p.length; k += 2) {
    if (p[k] < x0) x0 = p[k]; if (p[k] > x1) x1 = p[k];
    if (p[k + 1] < z0) z0 = p[k + 1]; if (p[k + 1] > z1) z1 = p[k + 1];
    if (k >= 2) len += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
  }
  return { p, ys, hw, cls, len, bbox: [x0 - hw - 1, z0 - hw - 1, x1 + hw + 1, z1 + hw + 1] };
};

// Two decks crossing at the SAME height are a data error: the shorter way's parapets end up
// lying across the longer deck ("broken bridge" on Заводская/Масштабная). Genuine stacked bridges
// differ by metres, so only near-identical elevations qualify; keep the longer way.
export const redundantDeck = (short, long) => {
  if (short === long) return false;
  // A footway running parallel inside a road bridge's corridor is its sidewalk: the road deck
  // already carries the crossing, and a second parapet fan on top reads as a broken bridge.
  const walkway = short.cls >= 8 && long.cls <= 7;
  if (!walkway && short.len >= long.len * 0.6) return false;
  const [x0, z0, x1, z1] = long.bbox;
  const R = long.hw + (walkway ? 2 : 1), R2 = R * R, tol = walkway ? 2.5 : 1.5;
  for (let i = 0; i + 3 < short.p.length; i += 2) {
    const ax = short.p[i], az = short.p[i + 1], sx = short.p[i + 2] - ax, sz = short.p[i + 3] - az;
    const sl = Math.hypot(sx, sz) || 1;
    const steps = Math.max(1, Math.ceil(sl / 5));
    for (let m = 0; m <= steps; m++) {
      const f = m / steps, x = ax + sx * f, z = az + sz * f;
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      const y = (short.ys[i / 2] + (short.ys[i / 2 + 1] - short.ys[i / 2]) * f) / 100;
      for (let j = 0; j + 3 < long.p.length; j += 2) {
        const lx = long.p[j], lz = long.p[j + 1], dx = long.p[j + 2] - lx, dz = long.p[j + 3] - lz;
        const L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - lx) * dx + (z - lz) * dz) / L2));
        const ex = x - lx - dx * t, ez = z - lz - dz * t;
        if (ex * ex + ez * ez > R2) continue;
        // parallel walkways: reject crossed decks (a real second crossing at an angle)
        if (walkway && Math.abs((sx * dz - sz * dx) / (sl * Math.sqrt(L2))) > 0.42) continue;
        const ly = (long.ys[j / 2] + (long.ys[j / 2 + 1] - long.ys[j / 2]) * t) / 100;
        if (Math.abs(y - ly) < tol) return true;
      }
    }
  }
  return false;
};

// does a building (flat [x,z,...] footprint, `top` in metres) intersect an elevated deck?
export const buildingHitsDeck = (bp, top, deck) => {
  if (top < 0.5) return false;
  let bx0 = 1e9, bz0 = 1e9, bx1 = -1e9, bz1 = -1e9, cx = 0, cz = 0;
  const n = bp.length / 2;
  for (let k = 0; k < bp.length; k += 2) {
    if (bp[k] < bx0) bx0 = bp[k]; if (bp[k] > bx1) bx1 = bp[k];
    if (bp[k + 1] < bz0) bz0 = bp[k + 1]; if (bp[k + 1] > bz1) bz1 = bp[k + 1];
    cx += bp[k]; cz += bp[k + 1];
  }
  cx /= n; cz /= n;
  const [x0, z0, x1, z1] = deck.bbox;
  if (bx1 < x0 || bx0 > x1 || bz1 < z0 || bz0 > z1) return false;
  const R = deck.hw + 0.5, R2 = R * R;
  const pts = [];
  for (let k = 0; k < bp.length; k += 2) pts.push([bp[k], bp[k + 1]]);
  pts.push([cx, cz]); // a large building can straddle the corridor with all vertices outside
  for (let i = 0; i + 1 < deck.p.length / 2; i++) {
    const y0 = deck.ys[i] / 100, y1 = deck.ys[i + 1] / 100;
    const ax = deck.p[i * 2], az = deck.p[i * 2 + 1], bx = deck.p[i * 2 + 2], bz = deck.p[i * 2 + 3];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
    for (const [x, z] of pts) {
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const ex = x - ax - dx * t, ez = z - az - dz * t;
      if (ex * ex + ez * ez > R2) continue;
      // the ramp climbs along the segment: test the deck height at the closest point, not at
      // either end — a house on the bank must not be caught by the far end of a long ramp
      const y = y0 + (y1 - y0) * t;
      if (y >= 1.2 && top >= y - 0.5) return true;
    }
  }
  return false;
};
