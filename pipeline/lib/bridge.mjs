// bridge deck helpers (docs/mpk-format.md road flags bit1 + ys). OSM bridge tagging is spotty in
// new cities, so the pipeline detects untagged road crossings over large water and elevates them
// anyway — the same class of defect must not reach the renderer twice. Pure functions: node tests
// call them directly, build-city.mjs wires them into the road pass.

// even-odd point-in-ring, strictly inside (points ON the ring — the bank — are not)
const pip = (x, z, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const x1 = pts[i], z1 = pts[i + 1], x2 = pts[j], z2 = pts[j + 1];
    if ((z1 > z) !== (z2 > z) && x < x1 + ((x2 - x1) * (z - z1)) / (z2 - z1)) inside = !inside;
  }
  return inside;
};
// proper crossing of ab and cd, both sides strict (bank-touching endpoints don't count)
const segCross = (ax, az, bx, bz, cx, cz, dx, dz) => {
  const s1 = Math.sign((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
  const s2 = Math.sign((bx - ax) * (dz - az) - (bz - az) * (dx - ax));
  const s3 = Math.sign((dx - cx) * (az - cz) - (dz - cz) * (ax - cx));
  const s4 = Math.sign((dx - cx) * (bz - cz) - (dz - cz) * (bx - cx));
  return s1 !== 0 && s2 !== 0 && s3 !== 0 && s4 !== 0 && s1 !== s2 && s3 !== s4;
};
const area2 = (pts) => { let a = 0; for (let i = 0; i < pts.length; i += 2) { const j = (i + 2) % pts.length; a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1]; } return a / 2; };
// strictly inside AND clear of the banks: a way along the waterline (embankment street) must not
// read as a bridge, but a way genuinely over the water does. Raw pip is boundary-fuzzy, so the
// point also needs some clearance from every edge
const deepInside = (x, z, pts, eps = 1.5) => {
  if (!pip(x, z, pts)) return false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[j], bz = pts[j + 1];
    const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x - (ax + dx * t), z - (az + dz * t)) < eps) return false;
  }
  return true;
};

// does this polyline (flat [x,z,...] m) actually cross any of the water polys? a way running
// along the bank or ending on it stays a normal road; only real enter-and-exit trips count.
// Polys are bbox-prefiltered (cached on the poly object): 30k roads × river polys must stay cheap
export const crossesWater = (pts, polys, { minArea = 2000 } = {}) => {
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i]; if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < z0) z0 = pts[i + 1]; if (pts[i + 1] > z1) z1 = pts[i + 1];
  }
  for (const wp of polys) {
    if (Math.abs(wp.area) < minArea) continue;
    if (wp.bbox === undefined) {
      let a0 = 1e9, b0 = 1e9, a1 = -1e9, b1 = -1e9;
      for (let i = 0; i < wp.pts.length; i += 2) {
        if (wp.pts[i] < a0) a0 = wp.pts[i]; if (wp.pts[i] > a1) a1 = wp.pts[i];
        if (wp.pts[i + 1] < b0) b0 = wp.pts[i + 1]; if (wp.pts[i + 1] > b1) b1 = wp.pts[i + 1];
      }
      wp.bbox = [a0, b0, a1, b1];
    }
    const [a0, b0, a1, b1] = wp.bbox;
    if (x1 < a0 || x0 > a1 || z1 < b0 || z0 > b1) continue;
    const p = wp.pts;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      if (deepInside(pts[i], pts[i + 1], p)) return true;
      for (let j = 0, k = p.length - 2; j < p.length; k = j, j += 2)
        if (segCross(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], p[j], p[j + 1], p[k], p[k + 1])) return true;
    }
    if (deepInside(pts[pts.length - 2], pts[pts.length - 1], p)) return true;
  }
  return false;
};

// deck heights in absolute cm (ground base 6 cm included) along the way: flat deck in the middle,
// smooth ramps back down to the road base at both ends, so joints with ordinary ways stay seamless.
// The ramp shrinks with the span (min(rampM, 0.42·len)) — a stream footbridge ramps steeply but
// still lands on the road base at its ends.
export const deckHeights = (pts, deckM, rampM = 30) => {
  const n = pts.length / 2, out = new Array(n);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  const L = cum[n - 1] || 1, R = Math.min(rampM, L * 0.42);
  const ss = (t) => t * t * (3 - 2 * t);
  for (let i = 0; i < n; i++) {
    const e = Math.min(cum[i], L - cum[i]); // distance to the nearest end
    out[i] = Math.round(6 + (deckM * 100 - 6) * (R > 0 ? ss(Math.min(e / R, 1)) : 1));
  }
  return out;
};

// height at a fractional vertex index (run clip boundaries interpolate between source vertices)
export const ysAt = (ys, fi) => {
  const f = Math.max(0, Math.min(fi, ys.length - 1)), lo = Math.floor(f), hi = Math.min(lo + 1, ys.length - 1);
  return ys[lo] + (ys[hi] - ys[lo]) * (f - lo);
};
