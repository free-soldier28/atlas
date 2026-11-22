// Node harness for the engine's world builder — no GPU, no browser, no engine changes.
//
// source/build.mjs concatenates src/*.js in a fixed order into ONE script; the world-building
// subset (math → format → globals → materials → citygen → world) is pure JS, so the same
// concatenation evals in Node. Two adaptations, both confined to this file:
//  - quality.js cannot eval outside a browser (adapter request, top-level await) — nothing in
//    the subset references its symbols today (world.js/citygen.js/globals.js are clean), so its
//    slot carries minimal LV=0 stubs with quality.js's exact QL semantics for future growth.
//  - sh_scene.js needs a device; only its material table M is needed, lifted verbatim by regex.
// The subset is eval'd ONCE as a single script per process, exactly like build.mjs: function
// declarations become globalThis properties, top-level consts live in the script's lexical
// scope (captured via a trailing export), and are NOT visible across separate evals — so
// re-boots must reuse this module, never re-eval.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const src = (f) => readFileSync(path.join(root, 'source/src', f), 'utf8');

let bootPromise = null;
export const engine = async () => {
  if (!bootPromise) bootPromise = (async () => {
    // build.mjs's FILES order minus the browser-only files
    const script = [
      src('math.js'),
      'const LV = 0; const QL = (h, m, l) => (LV > 1 ? l : LV ? m : h);', // quality.js slot, LV=0 semantics
      src('format.js'),
      src('globals.js'),
      /^const M = \{[^}]*\};/m.exec(src('sh_scene.js'))[0], // material ids, verbatim from sh_scene.js
      src('citygen.js'),
      src('world.js'),
    ].join('\n');
    (0, eval)(script + '\n;globalThis.__atlasEngine = { M, K, WATER, mpkOpen, mpkTile, mpkGraph, buildWorld };');
    return globalThis.__atlasEngine;
  })();
  return bootPromise;
};

// open a pack from the repo root (relative path); tiles stay inflated on demand (buildWorld pulls them)
export const openPack = async (rel) => {
  const E = await engine();
  return E.mpkOpen(new Uint8Array(readFileSync(path.join(root, rel))));
};

export const geoToLocal = (lat, lon, lat0, lon0) => [(lon - lon0) * Math.cos(lat0 * Math.PI / 180) * 111320, -(lat - lat0) * 111320];
