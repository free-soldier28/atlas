// ring closure + provenance: polygon records (water kinds 0-3, green) must arrive CLOSED
// (first == last within 1 cm) and every water line record must be an open kinds 8-10 centreline —
// the contract docs/mpk-format.md names explicitly. An open ring spills when the renderer
// triangulates it as a simple polygon; a closed centreline doubles its first segment.
// Building footprints are deliberately NOT in the closed-ring contract (the doc names water 0-3
// and green only; build-city's ringPts drops the closing duplicate and citygen wraps them
// defensively), so they are checked for shape, not closure. Across BOTH packs: grodno = the real
// pipeline, sample = the mksample.mjs fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPackFile } from './helpers.mjs';

const TOL2 = 1 + 1e-9; // 1 cm in the Int32 cm grid (dx² + dz² ≤ 1 cm²)
const closed = (pts) => {
  const dx = pts[0] - pts[pts.length - 2], dz = pts[1] - pts[pts.length - 1];
  return dx * dx + dz * dz <= TOL2;
};

test('grodno.mpk: polygon rings closed (water 0-3, green); water lines 8-10 open; buildings well-formed', async () => {
  const P = await openPackFile('packs/grodno.mpk');
  let b = 0, bBad = 0, wp = 0, wpOpen = 0, wl = 0, wlClosed = 0, g = 0, gOpen = 0;
  const wKinds = {};
  for (const [tx, tz] of P.h.tiles) {
    const t = await globalThis.mpkTile(P, P.h.tiles.findIndex(([x, z]) => x === tx && z === tz));
    for (const layers of t.lods) for (const L of layers) {
      if (L.kind === 1) {
        for (const r of L.recs) { b++; if (r.pts.length < 6) bBad++; } // ≥3 points; closure not required (see header)
      } else if (L.kind === 3) {
        for (const r of L.recs) {
          if (r.kind <= 3) { wp++; wKinds[r.kind] = (wKinds[r.kind] || 0) + 1; if (!closed(r.pts)) wpOpen++; }
          else if (r.kind >= 8 && r.kind <= 10) { wl++; if (closed(r.pts)) wlClosed++; }
          else assert.fail(`water record kind ${r.kind} outside the polygon (0-3) / line (8-10) table`);
        }
      } else if (L.kind === 4) {
        for (const r of L.recs) { g++; if (!closed(r.pts)) gOpen++; }
      }
    }
  }
  console.log(`ring-closure grodno: buildings ${b} (malformed ${bBad}), water polys ${wp} ${JSON.stringify(wKinds)} (open ${wpOpen}), water lines ${wl} (closed ${wlClosed}), green ${g} (open ${gOpen})`);
  assert.equal(bBad, 0, 'malformed building footprints');
  assert.equal(wpOpen, 0, 'open water polygon rings — the renderer triangulates them as simple polygons, an open ring spills');
  assert.equal(wlClosed, 0, 'closed water line records — centrelines must stay open (a closed one doubles the first segment)');
  assert.equal(gOpen, 0, 'open green rings');
  assert.ok(wp > 200 && wl > 100 && g > 3000 && b > 30000, 'water/green/building coverage far below the known build');
});

test('sample.mpk: same closure contract (one documented exception)', async () => {
  const P = await openPackFile('packs/sample.mpk');
  const isParkException = (tx, tz, r) =>
    // KNOWN DEVIATION: mksample.mjs's park predates the v2 closed-ring contract and packs must
    // not be rebuilt for tests. The exception matches that ONE record precisely (tile + shape);
    // if mksample.mjs changes the park (or closes it), it stops matching and this test flags it.
    tx === 0 && tz === 0 && r.pts.length === 8 && r.pts[0] === 4000 && r.pts[1] === 8000 && r.pts[6] === 4000 && r.pts[7] === 20000;
  let b = 0, bBad = 0, wp = 0, wpOpen = 0, wl = 0, wlClosed = 0, g = 0, gOpen = 0, parkExceptions = 0;
  for (const [tx, tz] of P.h.tiles) {
    const t = await globalThis.mpkTile(P, P.h.tiles.findIndex(([x, z]) => x === tx && z === tz));
    for (const layers of t.lods) for (const L of layers) {
      if (L.kind === 1) {
        for (const r of L.recs) { b++; if (r.pts.length < 6) bBad++; }
      } else if (L.kind === 3) {
        for (const r of L.recs) {
          if (r.kind <= 3) { wp++; if (!closed(r.pts)) wpOpen++; }
          else if (r.kind >= 8 && r.kind <= 10) { wl++; if (closed(r.pts)) wlClosed++; }
          else assert.fail(`water record kind ${r.kind} outside 0-3 / 8-10`);
        }
      } else if (L.kind === 4) {
        for (const r of L.recs) {
          g++;
          if (closed(r.pts)) continue;
          if (isParkException(tx, tz, r)) parkExceptions++;
          else gOpen++;
        }
      }
    }
  }
  console.log(`ring-closure sample: buildings ${b} (malformed ${bBad}), water polys ${wp} (open ${wpOpen}), lines ${wl} (closed ${wlClosed}), green ${g} (open ${gOpen}, park exception ${parkExceptions})`);
  assert.equal(bBad, 0, 'malformed building footprints');
  assert.equal(wpOpen, 0, 'open water polygon rings');
  assert.equal(wlClosed, 0, 'closed water line records');
  assert.equal(gOpen, 0, 'open green rings beyond the documented mksample park exception');
  assert.equal(parkExceptions, 1, 'the mksample park exception must match exactly one record');
  // light fixture pins: the exception covers exactly the green content sample has, and there is
  // no water — update these (and the exception) when mksample.mjs's fixture changes
  assert.equal(g, 1, 'sample green record count changed — revisit the park exception');
  assert.equal(wp + wl, 0, 'sample gained water records — the closure checks above are no longer vacuous, tighten them');
});

test('provenance: buildings carry osmId + sane src bits (sample exempt: synthetic, osmId=0)', async () => {
  const P = await openPackFile('packs/grodno.mpk');
  const S = await openPackFile('packs/sample.mpk');
  let noId = 0, badHsrc = 0, reserved = 0, n = 0;
  for (const t of P.tiles.values()) for (const lods of t.lods) for (const L of lods) if (L.kind === 1) for (const r of L.recs) {
    n++;
    if (!r.osmId) noId++;            // every real building is the improvement loop's OSM address
    if ((r.src & 3) > 2) badHsrc++;  // height source: doc defines 0 prior, 1 levels, 2 height tag
    if (r.src & 0xe0) reserved++;    // src bits 5-7 reserved, must stay 0
  }
  let sN = 0;
  for (const t of S.tiles.values()) for (const lods of t.lods) for (const L of lods) if (L.kind === 1) for (const r of L.recs) sN++;
  console.log(`provenance: grodno buildings ${n} (osmId=0: ${noId}, hsrc>2: ${badHsrc}, reserved bits set: ${reserved}), sample buildings ${sN} (all osmId=0 by design)`);
  assert.equal(noId, 0, 'buildings with osmId=0 — provenance lost');
  assert.equal(badHsrc, 0, 'height-source bits outside the documented 0-2');
  assert.equal(reserved, 0, 'reserved src bits set');
  assert.ok(sN > 0, 'sample pack decoded no buildings');
});
