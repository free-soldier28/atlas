// counts: the pack must contain exactly the cached building ways (closed rings; relation
// outer rings are the documented v1 delta, holes logged) and ≥95% of all highway ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPack, readCache } from './helpers.mjs';

const isClosed = (g) => g && g.length >= 4 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
// a ring the builder can actually emit: closed and every point present (no clipped nulls)
const usable = (e) => e.tags?.building && e.tags.building !== 'no' && isClosed(e.geometry) && e.geometry.every(Boolean);

const countKind = (P, kind) => {
  let n = 0;
  for (const t of P.tiles.values()) for (const lods of t.lods) for (const layer of lods) if (layer.kind === kind) n += layer.recs.length;
  return n;
};

test('buildings: pack records == closed building ways + relation outer rings (holes logged)', async () => {
  const P = await openPack();
  const els = readCache('buildings');
  const closed = els.filter((e) => e.type === 'way' && usable(e));
  const open = els.filter((e) => e.type === 'way' && e.tags?.building && e.tags.building !== 'no' && !usable(e));
  const closedIds = new Set(closed.map((w) => w.id));
  let rel = 0, holes = 0, openOuter = 0;
  for (const r of els) {
    if (r.type !== 'relation' || !r.tags?.building || !r.members) continue;
    for (const m of r.members) {
      if (m.type !== 'way' || !m.geometry) continue;
      if (m.role === 'inner') { holes++; continue; }
      if (m.role !== 'outer') continue;
      if (!isClosed(m.geometry) || !m.geometry.every(Boolean)) { openOuter++; continue; }
      if (closedIds.has(m.ref)) continue; // already a standalone building
      rel++;
    }
  }
  const packB = countKind(P, 1);
  console.log(`counts: closed building ways ${closed.length}, relation outer rings ${rel}` +
    ` (open ways ${open.length} arrive via relations; holes dropped ${holes}, open outer skipped ${openOuter})` +
    ` → expected ${closed.length + rel}, pack has ${packB}`);
  assert.equal(packB, closed.length + rel);
  assert.ok(closed.length > 30000, 'closed way count far below the measured Overpass total');
});

test('roads: every cached highway way appears in the pack (recs ≥ 95% of ways)', async () => {
  const P = await openPack();
  const ways = readCache('roads').filter((e) => e.type === 'way' && e.tags?.highway).length;
  const recs = countKind(P, 2);
  console.log(`counts: highway ways ${ways}, road records in pack ${recs} (${(100 * recs / ways).toFixed(1)}%)`);
  assert.ok(recs >= 0.95 * ways, `road recs ${recs} < 95% of ${ways}`);
});
