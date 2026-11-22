// height histogram + source breakdown: where do the h=60 apartments come from?
// src bits 0-1: 0 prior, 1 levels, 2 height tag. usage: node tools/heightscan.mjs
import { openPack, engine } from '../pipeline/lib/worldharness.mjs';

const E = await engine();
const P = await openPack(process.argv[2] || 'packs/grodno.mpk');
const S = P.h.tileSize;
const buckets = new Map(); // h -> {n, prior, levels, tag, kinds:Map}
let n = 0;
for (let i = 0; i < P.h.tiles.length; i++) {
  const T = await E.mpkTile(P, i), lods = T.lods[T.lods.length - 1];
  for (const L of lods) if (L.kind === 1) for (const r of L.recs) {
    n++;
    const h = r.h10 / 10, src = (r.src & 3);
    const b = buckets.get(h) || { n: 0, prior: 0, levels: 0, tag: 0, kinds: {} };
    b.n++; b[src === 2 ? 'tag' : src === 1 ? 'levels' : 'prior']++;
    b.kinds[r.bkind] = (b.kinds[r.bkind] || 0) + 1;
    buckets.set(h, b);
  }
}
const rows = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n);
console.log(`total ${n}`);
for (const [h, b] of rows.slice(0, 30)) {
  const kinds = Object.entries(b.kinds).map(([k, c]) => `${k}:${c}`).join(' ');
  console.log(`h=${String(h).padStart(6)} n=${String(b.n).padStart(5)}  prior=${String(b.prior).padStart(5)} levels=${String(b.levels).padStart(5)} tag=${String(b.tag).padStart(4)}  kinds ${kinds}`);
}
// how many at exactly the clamp ceiling?
let at60 = 0, at60Kinds = {};
for (const [h, b] of buckets) if (h === 60) { at60 += b.n; for (const k in b.kinds) at60Kinds[k] = (at60Kinds[k] || 0) + b.kinds[k]; }
console.log(`\nat exactly 60 m: ${at60} (${(100 * at60 / n).toFixed(1)}%) kinds:`, JSON.stringify(at60Kinds));
