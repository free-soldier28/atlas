// road/water ribbons (world.js ribbon): per-segment butt quads alone left wedge gaps at every
// bend — "paths with gaps", the notch growing with the road's width (the big avenue's joints
// gaped metres deep). Every interior vertex now also gets a joint quad between the two end
// lines. The net: a V-shaped road through buildWorld; a sample point on the outer bisector of
// the bend — the exact spot a butt-only strip leaves open — must be covered by a road triangle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../lib/worldharness.mjs';
import { MPKBuilder } from '../lib/pack.mjs';

const CM = 100;

test('ribbon joints: the outer side of a bend is covered (no wedge gaps)', async () => {
  const E = await engine();
  // one road: east then north (a 90° bend), 10 m wide (hw 5), tile (0,0), tile-local cm
  const pts = [20, 60, 100, 60, 100, 140].map((v) => v * CM);
  const B = new MPKBuilder({ id: 'ribbon-test', name: 'ribbon-test', attribution: 'test', origin: [54, 28], tileSize: 512, bbox: [53.99, 27.98, 54.01, 28.01] });
  B.tile(0, 0, [[{ kind: 2, recs: [{ cls: 2, flags: 0, name: '', lanes: 2, w10: 100, pts }] }]]);
  const P = E.mpkOpen(new Uint8Array(B.finish()));
  const W = await E.buildWorld(P);
  // the road mesh: single-LOD solid with M.PAVE material (dashes are PLASTER, ground is GROUND)
  const road = W.meshes.find((m) => new Uint8Array(m.vb)[16] === E.M.PAVE);
  assert.ok(road, 'road mesh exists');
  const vb = new Float32Array(road.vb);
  // instances sit at the tile centre; mesh verts are tile-centre-local → world = vert + instance
  let ix = 0, iz = 0;
  for (let i = 0; i < W.nI; i++) { const o = i * 12; if (new Uint32Array(W.inst)[o + 9] === W.types.findIndex((T) => T.lods.length === 1 && W.meshes[T.lods[0]] === road)) { ix = new Float32Array(W.inst)[o]; iz = new Float32Array(W.inst)[o + 2]; } }
  // covered(x, z): the point (world metres, road plane) inside some road triangle
  const triN = road.ib.length / 3;
  assert.equal(triN, 4, `the continuous strip carries one quad per segment, got ${triN} tris`);
  const covered = (x, z) => {
    x -= ix; z -= iz;
    for (let t = 0; t < road.ib.length; t += 3) {
      const a = road.ib[t] * 5, b = road.ib[t + 1] * 5, c = road.ib[t + 2] * 5;
      const ax = vb[a], az = vb[a + 2], bx = vb[b], bz = vb[b + 2], cx = vb[c], cz = vb[c + 2];
      const s1 = (bx - ax) * (z - az) - (bz - az) * (x - ax), s2 = (cx - bx) * (z - bz) - (cz - bz) * (x - bx), s3 = (ax - cx) * (z - cz) - (az - cz) * (x - cx);
      if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
    }
    return false;
  };
  // the bend at (100, 60), hw 5: (103, 57) is the outer wedge a butt-only strip leaves open
  assert.ok(covered(103, 57), 'bend outer wedge uncovered — the joint quad is missing');
  // sanity: segment middles and the inner side are covered, the far off-road is not
  assert.ok(covered(60, 60), 'segment midpoint uncovered');
  assert.ok(covered(100, 100), 'second segment midpoint uncovered');
  assert.ok(covered(97, 63), 'bend inner side uncovered');
  assert.ok(!covered(110, 50), 'off-road point reported covered');
});
