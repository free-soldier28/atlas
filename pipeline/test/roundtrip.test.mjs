// format roundtrip: packs/grodno.mpk must decode cleanly under the engine decoder
// (source/src/format.js) with sane record shapes, clamped heights, and coordinates
// that fall inside the pack bbox (±2 km margin), tile-local coords unfolded first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPack } from './helpers.mjs';

const ORIGIN = [53.6784, 23.8291], BBOX = [53.62, 23.70, 53.76, 23.96];
const cos0 = Math.cos(ORIGIN[0] * Math.PI / 180);
const XLO = (BBOX[1] - ORIGIN[1]) * cos0 * 111320, XHI = (BBOX[3] - ORIGIN[1]) * cos0 * 111320; // metres
const ZLO = Math.min(-(BBOX[2] - ORIGIN[0]) * 111320, -(BBOX[0] - ORIGIN[0]) * 111320);
const ZHI = Math.max(-(BBOX[2] - ORIGIN[0]) * 111320, -(BBOX[0] - ORIGIN[0]) * 111320);
const MARGIN = 2000 * 100 + 2; // 2 km + 1 cm float slack. The builder clips content to bbox+2 km
                               // (`out geom` returns full way geometry, tails are cut), so every
                               // stored point — anchor or not — must sit inside bbox ± 2 km.
const HARD = 40000 * 100;      // 40 km: projection-bug net (defense in depth)

test('grodno.mpk: header, tiles present', async () => {
  const P = await openPack(false);
  assert.equal(P.h.v, 2);
  assert.equal(P.h.id, 'grodno');
  assert.deepEqual(P.h.origin, ORIGIN);
  assert.deepEqual(P.h.bbox, BBOX);
  assert.ok(P.h.tiles.length > 0, 'no tiles');
  assert.ok(P.h.graph, 'no graph');
  assert.ok(Array.isArray(P.h.poses) && P.h.poses.length === 6, 'poses');
  assert.equal(P.h.fly, null);
  assert.equal(P.h.terrain, null);
});

test('grodno.mpk: every tile decodes, record shapes sane', async () => {
  const P = await openPack();
  assert.equal(P.tiles.size, P.h.tiles.length, 'not every tile decoded');
  let nB = 0, nR = 0, nW = 0, nG = 0;
  P.h.tiles.forEach(([tx, tz], i) => {
    const t = P.tiles.get(i);
    assert.ok(t && t.lods.length >= 1);
    for (const layers of t.lods) for (const layer of layers) {
      for (const r of layer.recs) {
        assert.ok(r.pts instanceof Int32Array && r.pts.length % 2 === 0, `tile ${tx},${tz}: odd pt array`);
        const even = r.pts.length;
        if (layer.kind === 1) { // buildings: ≥3 pts, height clamp 2.5–60 m (churches to 80)
          nB++;
          assert.ok(even >= 6, `building with ${even / 2} pts`);
          assert.ok(r.bkind <= 7 && r.roof <= 2, `bkind ${r.bkind} roof ${r.roof}`);
          assert.ok(r.h10 >= 25 && r.h10 <= (r.bkind === 5 ? 800 : 600), `h10 ${r.h10} out of clamp`);
          assert.ok(r.base10 >= 0 && r.base10 <= r.h10, `base10 ${r.base10} vs h10 ${r.h10}`);
        } else if (layer.kind === 2) { // roads: ≥2 pts, name index in range
          nR++;
          assert.ok(even >= 4, `road with ${even / 2} pts`);
          assert.ok(r.cls <= 10, `road cls ${r.cls}`);
          assert.ok(r.name < P.h.strings.length, `road name index ${r.name} ≥ strings.length`);
        } else if (layer.kind === 3 || layer.kind === 4) { // water / green polygons & lines
          layer.kind === 3 ? nW++ : nG++;
          assert.ok(even >= 4, `kind ${layer.kind} record with ${even / 2} pts`);
        } else assert.fail(`unexpected layer kind ${layer.kind}`);
        // coordinates: unfold tile-local cm → pack-local cm; content is clipped to bbox ± 2 km,
        // so every stored point must sit inside that (the ±40 km net catches projection bugs).
        for (let j = 0; j < even; j += 2) {
          const x = tx * 512 * 100 + r.pts[j], z = tz * 512 * 100 + r.pts[j + 1];
          assert.ok(x >= (XLO * 100 - MARGIN) && x <= (XHI * 100 + MARGIN), `x ${x / 100 | 0} m out of bbox+2km`);
          assert.ok(z >= (ZLO * 100 - MARGIN) && z <= (ZHI * 100 + MARGIN), `z ${z / 100 | 0} m out of bbox+2km`);
          assert.ok(x >= (XLO * 100 - HARD) && x <= (XHI * 100 + HARD) && z >= (ZLO * 100 - HARD) && z <= (ZHI * 100 + HARD), 'wildly out of bbox (projection bug?)');
        }
      }
    }
  });
  console.log(`roundtrip: decoded ${P.h.tiles.length} tiles — buildings ${nB}, roads ${nR}, water ${nW}, green ${nG}`);
  assert.ok(nB > 30000 && nR > 30000, 'record counts far below the measured Overpass totals');
});

test('grodno.mpk: water polygons (kinds 0-3) and green rings arrive CLOSED, water lines are 8-10', async () => {
  const P = await openPack();
  // polygon records must end where they start (1 cm = 1 unit in the Int32 cm grid); the renderer
  // triangulates them as simple polygons, so an open ring would spill. Lines (8-10) are centrelines
  // widened into ribbons — they must NOT be closed (a closed centreline doubles the first segment).
  const isClosed = (pts) => pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1];
  let polys = 0, openPolys = 0, lines = 0, closedLines = 0, green = 0, openGreen = 0;
  const kinds = {};
  for (const t of P.tiles.values()) for (const layers of t.lods) for (const layer of layers) {
    if (layer.kind !== 3 && layer.kind !== 4) continue;
    for (const r of layer.recs) {
      const closed = isClosed(r.pts);
      if (layer.kind === 4) { green++; if (!closed) openGreen++; continue; }
      kinds[r.kind] = (kinds[r.kind] || 0) + 1;
      if (r.kind <= 3) { polys++; assert.ok(closed, `water polygon kind ${r.kind} open — rings must arrive closed`); if (!closed) openPolys++; }
      else if (r.kind <= 10) { lines++; assert.ok(r.kind >= 8, `water line kind ${r.kind} outside 8-10`); if (closed) closedLines++; }
      else assert.fail(`unknown water kind ${r.kind}`);
    }
  }
  console.log(`roundtrip: water polygons ${polys} (open ${openPolys}), lines ${lines} (closed ${closedLines}), green ${green} (open ${openGreen}) — kinds ${JSON.stringify(kinds)}`);
  assert.equal(openPolys, 0, 'open water polygon rings');
  assert.equal(closedLines, 0, 'closed water line records');
  assert.equal(openGreen, 0, 'open green rings');
  assert.ok(polys > 0 && lines > 0 && green > 0, 'no water/green content decoded');
});
