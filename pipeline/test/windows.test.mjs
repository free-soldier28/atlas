// windows & doors toggle: panes, bays and the door must live in their own K.GLASS mesh/type, so
// the drawer switch gates draws without rebuilding the world, and a pane's M.WINDOW material can
// never leak into the wall mesh that follows it (it used to colour the cornice as glass). The
// setting defaults to OFF. Pins the data side here; the runtime gate is probed in windows-probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { engine } from '../lib/worldharness.mjs';
import { MPKBuilder } from '../lib/pack.mjs';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const CM = 100;

test('windows + door geometry is isolated in K.GLASS; wall meshes carry no window material', async () => {
  const E = await engine();
  // a 30 x 20 m, 16 m tall apartment block: panes on all faces + bays + a door
  const pts = [240, 246, 270, 246, 270, 266, 240, 266].map((v) => v * CM);
  const B = new MPKBuilder({ id: 'win-test', name: 'win-test', attribution: 'test', origin: [54, 28], tileSize: 512, bbox: [53.99, 27.98, 54.01, 28.01] });
  B.tile(0, 0, [[{ kind: 1, recs: [{ pts, bkind: 1, roof: 0, h10: 160, base10: 0, osmId: 1, src: 0 }] }]]);
  const W = await E.buildWorld(E.mpkOpen(new Uint8Array(B.finish())));

  const glass = W.types.filter((T) => T.kind === E.K.GLASS);
  assert.ok(glass.length > 0, 'a K.GLASS type must exist for window geometry');
  const glassMeshes = new Set(glass.flatMap((T) => T.lods.map((l) => W.meshes[l])));
  const mats = (m) => {
    const b = new Uint8Array(m.vb), out = new Set();
    for (let i = 0; i < m.nv; i++) out.add(b[i * 20 + 16]);
    return out;
  };
  // panes are M.WINDOW; bays + door frames are M.ROCK — both must sit in the gated type
  const gm = new Set([...glassMeshes].flatMap((m) => [...mats(m)]));
  assert.ok(gm.has(E.M.WINDOW), 'window panes must be in the toggleable mesh');
  assert.ok(gm.has(E.M.ROCK), 'bay frames and the door must be in the same toggleable mesh');
  // no WINDOW vertices anywhere outside K.GLASS (walls, cornice, roads, roofs)
  for (const [i, T] of W.types.entries()) if (T.kind !== E.K.GLASS)
    for (const li of T.lods) assert.ok(!mats(W.meshes[li]).has(E.M.WINDOW), `WINDOW material leaked into type ${i}`);
  // the far LOD slot is an empty mesh: windows disappear before the far distance
  for (const T of glass) assert.equal(W.meshes[T.lods[2]].nv, 0, 'window type must have a zero-vertex far slot');
});

test('windows setting defaults to off and has a runtime setter', () => {
  const src = readFileSync(path.join(ROOT, 'source', 'src', 'main.js'), 'utf8');
  assert.match(src, /let windows = 0;/, 'windows must default to off');
  assert.match(src, /QP\.get\('win'\)/, '?win= query override required for headless probes');
  assert.match(src, /window\.__windows = setWindows/, 'runtime setter required for the toggle probe');
  assert.match(src, /localStorage\.atlasWin/, 'drawer choice must persist');
  const html = readFileSync(path.join(ROOT, 'source', 'template.html'), 'utf8');
  assert.match(html, /id=wi/, 'drawer must expose a windows & doors button');
});
