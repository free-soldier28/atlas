// label placement helpers — pure functions (concatenated before world.js); the node test extracts them.
// entries: { x, y, z, text, kind (0 house number, 1 street), priority (0 first), dist }
// The screen-space collision grid is what keeps dozens of house numbers from piling onto one spot;
// same text in the same world cell is one label (mapper cuts ways into many records per street).

const dedupe = (entries, { houseCell = 8, streetCell = 60 } = {}) => {
  const seen = new Set(), out = [];
  for (const e of entries) {
    const cell = e.kind === 1 ? streetCell : houseCell;
    const key = `${e.kind}|${e.text}|${Math.round(e.x / cell)},${Math.round(e.z / cell)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
};

// focus mode: keep only the street under the camera, the houses on that street, and at most
// `extra` more streets that are in front of the camera. The polyline samples on street entries
// (built in world.js) make this a pure function — no pack format change, no second data pass.
const focusLabels = (entries, cam, { under = 70, ahead = 260, house = 40, houseFar = 110, extra = 2 } = {}) => {
  const pathDist = (path, x, z) => {
    let best = Infinity;
    for (let i = 0; i + 1 < path.length; i += 2) {
      const dx = x - path[i], dz = z - path[i + 1], d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  const scored = [];
  for (const e of entries) if (e.kind === 1 && e.path) scored.push({ e, d: pathDist(e.path, cam.x, cam.z) });
  scored.sort((a, b) => a.d - b.d);
  const inCone = (e) => {
    const dx = e.x - cam.x, dz = e.z - cam.z;
    return (dx * cam.fx + dz * cam.fz) / Math.max(1, Math.hypot(dx, dz)) >= 0.5;
  };
  // the street under the camera wins; otherwise take the nearest one inside the camera's cone,
  // and as a last resort the nearest street at all — an empty overlay is worse than one label.
  let primary = scored.length && scored[0].d <= under ? scored[0].e : null;
  if (!primary) for (const s of scored) { if (s.d <= ahead && inCone(s.e)) { primary = s.e; break; } }
  if (!primary && scored.length && scored[0].d <= ahead) primary = scored[0].e;
  const picked = primary ? [primary] : [];
  for (const s of scored) {
    if (picked.length >= 1 + extra) break;
    if (s.e === primary || s.d > ahead || !inCone(s.e)) continue;
    picked.push(s.e);
  }
  const out = picked.slice();
  if (primary) for (const e of entries) {
    if (e.kind !== 0) continue;
    const dx = e.x - cam.x, dz = e.z - cam.z;
    if (dx * dx + dz * dz > houseFar * houseFar) continue;
    if (pathDist(primary.path, e.x, e.z) <= house) out.push(e);
  }
  return out;
};

// `project` maps an entry to [screenX, screenY, distance] and may return null when off-screen /
// behind the camera. Placement order: priority (street first), road rank, then nearest; a label
// claims every grid cell its box touches, so no two visible boxes can overlap (crossTileID's job,
// done locally). `unique` folds every repeated street name into its single best-placed instance.
const place = (entries, project, { W = 1280, H = 800, max = 90, cellW = 66, cellH = 26, pad = 3,
  widthOf = (t) => t.length * 6.6 + 14, height = 20, quota = {}, unique = false } = {}) => {
  const grid = new Set(), out = [], used = {}, shownText = new Set();
  const sorted = entries.slice().sort((a, b) => a.priority - b.priority || (a.rank || 0) - (b.rank || 0) || a.dist - b.dist);
  for (const e of sorted) {
    if (out.length >= max) break;
    if (quota[e.kind] !== undefined && (used[e.kind] || 0) >= quota[e.kind]) continue;
    if (unique && e.kind === 1 && shownText.has(e.text)) continue;
    const s = project(e);
    if (!s) continue;
    const [sx, sy, dist] = s, w = widthOf(e.text), h = height;
    const x0 = Math.floor(sx - w / 2 - pad), x1 = Math.floor(sx + w / 2 + pad);
    const y0 = Math.floor(sy - h / 2 - pad), y1 = Math.floor(sy + h / 2 + pad);
    if (x1 < 0 || x0 > W || y1 < 0 || y0 > H) continue;
    const cx0 = Math.floor(x0 / cellW), cx1 = Math.floor(x1 / cellW), cy0 = Math.floor(y0 / cellH), cy1 = Math.floor(y1 / cellH);
    let clash = false;
    for (let cx = cx0; cx <= cx1 && !clash; cx++) for (let cy = cy0; cy <= cy1; cy++)
      if (grid.has(cx + ',' + cy)) { clash = true; break; }
    if (clash) continue;
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) grid.add(cx + ',' + cy);
    used[e.kind] = (used[e.kind] || 0) + 1;
    if (unique && e.kind === 1) shownText.add(e.text);
    out.push({ ...e, sx, sy, dist });
  }
  return out;
};
