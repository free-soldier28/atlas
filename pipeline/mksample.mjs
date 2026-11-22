// builds packs/sample.mpk (+ packs/embed.mpk): a tiny synthetic world that smoke-tests the
// engine end to end — a block of buildings, a crossroad, a park, and a routing graph around it.
// Node usage: node pipeline/mksample.mjs
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MPKBuilder } from './lib/pack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const S = 512, CM = 100; // tileSize m, metres→cm

// a small grid of buildings west of the crossroad (tile 0,0) and east of it (tile 1,0)
const block = (x0, z0, out) => {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const x = x0 + i * 60, z = z0 + j * 55, w = 30 + 10 * ((i + j) % 2), d = 24 + 8 * ((i * 3 + j) % 3), h = [12, 18, 9, 27, 15, 21, 30, 12, 18][(i * 3 + j) % 9];
    out.push({ pts: [x, z, x + w, z, x + w, z + d, x, z + d].map((v) => (v - (x0 < 0 ? 0 : S)) * CM), bkind: i === 1 && j === 1 ? 2 : 1, roof: 0, h10: h * 10, base10: 0 });
  }
};
const west = [], east = [];
block(-140, -70, west), block(40, -70, east); // west is in tile x=-1, east in tile x=0

// roads: one N-S avenue and one E-W street crossing it (the crossroad), plus a footpath
const avenue = [[0, -220], [0, 220]].map(([x, z]) => [x * CM, z * CM]);
const street = [[-220, 30], [220, 30]].map(([x, z]) => [x * CM, z * CM]);
const footpath = [[-160, -180], [-60, -120], [-60, -20], [40, 40]].map(([x, z]) => [x * CM, z * CM]);
const roadRec = (pts, cls, name, w10) => ({ cls, flags: 0, name, lanes: cls < 4 ? 2 : 1, w10, pts });

// park southeast of the crossroad (tile 0,0)
const park = { kind: 0, pts: [[40, 80], [180, 80], [180, 200], [40, 200]].map(([x, z]) => [x * CM, z * CM]) };

// routing graph: the crossroad's four legs meet at two junctions
const nodes = [[0, -12000], [0, 12000], [-12000, 3000], [12000, 3000]]; // cm
const edges = [
  { a: 0, b: 1, cls: 2, flags: 0, name: 'Central Avenue', lanes: 2, speed: 60, len: 240 },
  { a: 1, b: 2, cls: 4, flags: 0, name: 'River Street', lanes: 1, speed: 50, len: 120 },
  { a: 1, b: 3, cls: 4, flags: 0, name: 'River Street', lanes: 1, speed: 50, len: 120 },
  { a: 0, b: 2, cls: 6, flags: 0, name: 'Mill Lane', lanes: 1, speed: 40, len: 150 },
  { a: 0, b: 3, cls: 6, flags: 0, name: 'Mill Lane', lanes: 1, speed: 40, len: 150 },
];

const B = new MPKBuilder({
  id: 'sample', name: 'Sample', attribution: 'synthetic test pack',
  origin: [53.6784, 23.8291], tileSize: S, bbox: [53.66, 23.79, 53.70, 23.87],
  poses: [[-220, 120, 220, 0, 0, 0], [0, 6, 160, 0, 14, 0], [160, 40, -160, 0, 10, 0], [0, 260, 480, 0, 0, 0]],
});
B.tile(-1, 0, [[{ kind: 1, recs: west }]]);                       // buildings only, one LOD
B.tile(0, 0, [[{ kind: 1, recs: east }, { kind: 2, recs: [roadRec(avenue, 2, 'Central Avenue', 120), roadRec(street, 4, 'River Street', 90), roadRec(footpath, 10, '', 30)] }, { kind: 4, recs: [park] }]]);
B.graph(nodes, edges);
const buf = B.finish();
mkdirSync(path.join(root, 'packs'), { recursive: true });
writeFileSync(path.join(root, 'packs/sample.mpk'), buf);
copyFileSync(path.join(root, 'packs/sample.mpk'), path.join(root, 'packs/embed.mpk'));
console.log(`sample.mpk: ${(buf.length / 1024).toFixed(1)} kB, ${B.h.tiles.length} tiles, ${nodes.length} nodes, ${edges.length} edges`);
