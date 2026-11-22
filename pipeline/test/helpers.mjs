// shared test helpers: load the engine decoder (source/src/format.js) and open packs with it —
// every pack the pipeline emits must decode under the engine's own reader.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const loadDecoder = () => {
  const src = readFileSync(path.join(root, 'source/src/format.js'), 'utf8');
  (0, eval)(src.replace('function mpkOpen', 'globalThis.mpkOpen = mpkOpen; globalThis.mpkTile = mpkTile; globalThis.mpkGraph = mpkGraph; function mpkOpen'));
};

// pack bounds in the local metre frame (docs/mpk-format.md: x east, -z north about origin)
export const frameOf = (h) => {
  const [lat0, lon0] = h.origin, cos0 = Math.cos(lat0 * Math.PI / 180);
  return {
    XLO: (h.bbox[1] - lon0) * cos0 * 111320, XHI: (h.bbox[3] - lon0) * cos0 * 111320,
    ZLO: -(h.bbox[2] - lat0) * 111320, ZHI: -(h.bbox[0] - lat0) * 111320,
    S: h.tileSize || 512,
  };
};

// opens the pack and (by default) decodes every tile; mpkTile/mpkGraph cache on P.
// Retried: determinism.test.mjs rebuilds grodno.mpk in place, and a read landing inside the
// builder's single writeFileSync window would see a truncated file — 5 tries cover it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const openPackFile = async (rel, decode = true) => {
  loadDecoder();
  for (let a = 0; ; a++) {
    try {
      const u8 = new Uint8Array(readFileSync(path.join(root, rel))); // fresh ArrayBuffer, offset 0
      const P = globalThis.mpkOpen(u8);
      if (decode) for (let i = 0; i < P.h.tiles.length; i++) await globalThis.mpkTile(P, i);
      return P;
    } catch (e) {
      if (a >= 4) throw e;
      await sleep(250);
    }
  }
};

export const openPack = async (decode = true) => openPackFile('packs/grodno.mpk', decode);

export const readCache = (n) => JSON.parse(readFileSync(path.join(root, 'pipeline/cache', `${n}.json`), 'utf8')).elements;
