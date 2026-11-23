// parapet/cornice roofline (citygen near LOD): the old protruding cornice (12 cm) over a recessed
// parapet face on the two longest walls only self-shadowed into a heavy dark band under the
// roofline at the golden-hour sun and broke off at every corner. Now the cornice is a flush
// painted band and the flat roof carries a 10 cm flush lip on EVERY face. This pins the geometry:
// the lip ring closes on all four sides, sits at top+0.1, and nothing in the roofline strip sticks
// out past ~3 cm — so no grazing-sun self-shadow surface can come back silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../lib/worldharness.mjs';
import { MPKBuilder } from '../lib/pack.mjs';

const CM = 100, TC = 256; // tile-local cm; the tile instance sits at its centre (256, 256)

const flatBlock = async () => {
  const E = await engine();
  // one 30 x 20 m flat-roof block, 16 m tall, inside tile (0,0): x 240..270, z 246..266 (m)
  const pts = [240, 246, 270, 246, 270, 266, 240, 266].map((v) => v * CM);
  const B = new MPKBuilder({ id: 'parapet-test', name: 'parapet-test', attribution: 'test', origin: [54, 28], tileSize: 512, bbox: [53.99, 27.98, 54.01, 28.01] });
  B.tile(0, 0, [[{ kind: 1, recs: [{ pts, bkind: 1, roof: 0, h10: 160, base10: 0, osmId: 1, src: 0 }] }]]);
  const W = await E.buildWorld(E.mpkOpen(new Uint8Array(B.finish())));
  // near walls: every 3-LOD type (walls carry slot 0 = near), PLASTER material
  const verts = [];
  W.types.forEach((T) => {
    if (T.lods.length !== 3 || T.kind !== E.K.SOLID) return;
    const m = W.meshes[T.lods[0]];
    if (new Uint8Array(m.vb)[16] !== E.M.PLASTER) return;
    const vb = new Float32Array(m.vb);
    for (let i = 0; i < m.nv; i++) verts.push([vb[i * 5] + TC, vb[i * 5 + 1], vb[i * 5 + 2] + TC]);
  });
  assert.ok(verts.length > 50, `near wall mesh must carry vertices, got ${verts.length}`);
  return verts;
};

test('flat roof: the parapet lip ring closes on all four faces at top+0.1', async () => {
  const verts = await flatBlock();
  const [x0, x1, z0, z1] = [240, 270, 246, 266], TOP = 16;
  // the lip is one lid quad per face — its vertices sit at the face's two ends; a side counts as
  // covered when lip-height vertices on that plane span the full extent
  for (const [side, onPlane, axis, a0, a1] of [
    ['west', ([x, z]) => Math.abs(x - x0) < 0.03, 2, z0, z1],
    ['east', ([x, z]) => Math.abs(x - x1) < 0.03, 2, z0, z1],
    ['south', ([x, z]) => Math.abs(z - z0) < 0.03, 0, x0, x1],
    ['north', ([x, z]) => Math.abs(z - z1) < 0.03, 0, x0, x1],
  ]) {
    const strip = verts.filter(([x, y, z]) => y > TOP + 0.09 && y < TOP + 0.11 && onPlane([x, z]));
    const vals = strip.map((p) => p[axis]);
    assert.ok(strip.length >= 4, `the parapet lip must run along the ${side} face, got ${strip.length} vertices`);
    assert.ok(Math.min(...vals) <= a0 + 0.03 && Math.max(...vals) >= a1 - 0.03, `the ${side} lip must span the whole face`);
  }
});

test('flat roof: the roofline is flush — nothing protrudes past 3 cm (no grazing-sun shelf)', async () => {
  const verts = await flatBlock();
  const [x0, x1, z0, z1] = [240, 270, 246, 266], TOP = 16;
  // the roofline strip: parapet lip + cornice band region
  const out = verts.filter(([x, y, z]) => y > TOP - 0.35 && y < TOP + 0.2 && x > x0 - 0.5 && x < x1 + 0.5 && z > z0 - 0.5 && z < z1 + 0.5)
    .map(([x, y, z]) => Math.max(x0 - x, x - x1, z0 - z, z - z1)); // distance outside the footprint
  assert.ok(out.length > 40, `roofline strip must carry geometry, got ${out.length}`);
  const worst = Math.max(...out);
  assert.ok(worst <= 0.03, `roofline sticks out ${worst.toFixed(3)} m past the wall — protruding details self-shadow into the dark band`);
});
