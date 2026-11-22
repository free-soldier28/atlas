// shared test helpers: load the engine decoder (source/src/format.js) and open packs/grodno.mpk
// with it — every pack the pipeline emits must decode under the engine's own reader.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const loadDecoder = () => {
  const src = readFileSync(path.join(root, 'source/src/format.js'), 'utf8');
  (0, eval)(src.replace('function mpkOpen', 'globalThis.mpkOpen = mpkOpen; globalThis.mpkTile = mpkTile; globalThis.mpkGraph = mpkGraph; function mpkOpen'));
};

// opens the pack and (by default) decodes every tile; mpkTile/mpkGraph cache on P
export const openPack = async (decode = true) => {
  loadDecoder();
  const u8 = new Uint8Array(readFileSync(path.join(root, 'packs/grodno.mpk'))); // fresh ArrayBuffer, offset 0
  const P = globalThis.mpkOpen(u8);
  if (decode) for (let i = 0; i < P.h.tiles.length; i++) await globalThis.mpkTile(P, i);
  return P;
};

export const readCache = (n) => JSON.parse(readFileSync(path.join(root, 'pipeline/cache', `${n}.json`), 'utf8')).elements;
