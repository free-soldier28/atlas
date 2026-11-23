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

// `project` maps an entry to [screenX, screenY, distance] and may return null when off-screen /
// behind the camera. Placement order: priority (street first), then nearest; a label claims every
// grid cell its box touches, so no two visible boxes can overlap (crossTileID's job, done locally).
const place = (entries, project, { W = 1280, H = 800, max = 90, cellW = 66, cellH = 26, pad = 3,
  widthOf = (t) => t.length * 6.6 + 14, height = 20, quota = {} } = {}) => {
  const grid = new Set(), out = [], used = {};
  const sorted = entries.slice().sort((a, b) => a.priority - b.priority || a.dist - b.dist);
  for (const e of sorted) {
    if (out.length >= max) break;
    if (quota[e.kind] !== undefined && (used[e.kind] || 0) >= quota[e.kind]) continue;
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
    out.push({ ...e, sx, sy, dist });
  }
  return out;
};
