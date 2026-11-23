// a footway crossing a road used to be coplanar with it (both at 0.06 m) and shimmered as the
// camera moved. The renderer now lifts walkable classes and adds a deterministic sub-cm
// tie-breaker, so the two SURFACES never share a depth at a crossing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../lib/worldharness.mjs';
import { MPKBuilder } from '../lib/pack.mjs';

test('footway ribbons sit above road ribbons at crossings', async () => {
  const E = await engine();
  const CM = 100;
  const B = new MPKBuilder({ id: 'crossing', name: 'crossing', attribution: 'test', origin: [54, 28], tileSize: 512, bbox: [53.99, 27.98, 54.01, 28.01] });
  B.tile(0, 0, [[
    { kind: 2, recs: [
      { cls: 2, flags: 0, name: 0, lanes: 2, w10: 120, pts: [4000, 10000, 20000, 10000] },
      { cls: 9, flags: 0, name: 0, lanes: 1, w10: 20, pts: [12000, 4000, 12000, 16000] },
    ] },
  ]]);
  const W = await E.buildWorld(E.mpkOpen(new Uint8Array(B.finish())));
  const ys = (mat) => W.meshes.filter((m) => new Uint8Array(m.vb)[16] === mat)
    .flatMap((m) => { const f = new Float32Array(m.vb); const out = []; for (let k = 0; k < f.length; k += 5) out.push(f[k + 1]); return out; });
  const road = ys(E.M.ASPHALT), walk = ys(E.M.PAVE);
  assert.ok(road.length && walk.length, 'both surfaces were built');
  const hiRoad = Math.max(...road), loWalk = Math.min(...walk);
  assert.ok(loWalk - hiRoad >= 0.005, `footway must clear every road vertex, got ${loWalk.toFixed(4)} - ${hiRoad.toFixed(4)}`);
});
