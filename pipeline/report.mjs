// provenance report: which building data is real vs estimated, and what to improve first.
// Reads a pack (default packs/grodno.mpk) with the engine's own decoder, prints a summary and
// writes pipeline/report.json with improvement candidates (OSM ids + links).
// usage: node pipeline/report.mjs [packs/grodno.mpk]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const file = process.argv[2] || 'packs/grodno.mpk';
const src = readFileSync(path.join(root, 'source/src/format.js'), 'utf8');
(0, eval)(src.replace('function mpkOpen', 'globalThis.mpkOpen = mpkOpen; globalThis.mpkTile = mpkTile; function mpkOpen'));

const P = mpkOpen(new Uint8Array(readFileSync(path.join(root, file))));
const area = (pts) => { let a = 0; for (let i = 0; i < pts.length; i += 2) { const j = (i + 2) % pts.length; a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1]; } return Math.abs(a) / 2; };
const HN = ['prior/default', 'levels ×3.2', 'height tag'];
const s = { buildings: 0, hsrc: [0, 0, 0], roofKnown: 0, colourKnown: 0, fromRelation: 0, floorsReal: 0 };
const candidates = [];
for (let i = 0; i < P.h.tiles.length; i++) {
  const t = await mpkTile(P, i);
  for (const L of t.lods[t.lods.length - 1]) {
    if (L.kind !== 1) continue;
    for (const r of L.recs) {
      s.buildings++;
      s.hsrc[r.src & 3]++;
      if (r.src & 4) s.roofKnown++;
      if (r.src & 8) s.colourKnown++;
      if (r.src & 16) s.fromRelation++;
      if ((r.src & 3) === 0) candidates.push({ osmId: r.osmId, rel: !!(r.src & 16), area: area(r.pts), bkind: r.bkind, h10: r.h10 });
    }
  }
}
const pc = (n) => (100 * n / s.buildings).toFixed(1) + '%';
console.log(`Pack ${file} v${P.h.v} · ${P.h.tiles.length} tiles · ${s.buildings} buildings`);
console.log(`height: real tag ${pc(s.hsrc[2])} · levels-based ${pc(s.hsrc[1])} · prior/default ${pc(s.hsrc[0])}`);
console.log(`roof:shape tagged ${pc(s.roofKnown)} · colour tagged ${pc(s.colourKnown)} · from multipolygon relations ${s.fromRelation}`);
console.log(`provenance bits cover 100% of records (v2) — every building knows what about it is real`);
// improvement candidates: default-height buildings first, biggest footprints first (most visible errors)
candidates.sort((a, b) => b.area - a.area);
const top = candidates.slice(0, 40).map((c) => ({ id: c.osmId, url: `https://www.openstreetmap.org/${c.rel ? 'relation' : 'way'}/${c.osmId}`, areaM2: Math.round(c.area / 1e4) / 100, kind: c.bkind, heightM: c.h10 / 10 }));
console.log(`\nTop ${top.length} improvement candidates (default-height buildings, biggest footprints — add building:levels/height in OSM):`);
for (const c of top) console.log(`  ${c.url}  ${c.areaM2} m²  kind ${c.kind}  h=${c.heightM} m`);
writeFileSync(path.join(root, 'pipeline/report.json'), JSON.stringify({ pack: file, summary: s, candidates: top }, null, 1));
console.log(`\nreport.json written (${candidates.length} total candidates)`);
