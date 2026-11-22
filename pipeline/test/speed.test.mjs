// speed: decoding every tile of the pack must stay under 5 s (engine budget).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPack } from './helpers.mjs';

test('speed: decode-all-tiles under 5 s', async () => {
  const t0 = performance.now();
  const P = await openPack();
  const ms = performance.now() - t0;
  console.log(`speed: ${P.h.tiles.length} tiles (${(P.u8.length / 1e6).toFixed(2)} MB pack) decoded in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 5000, `decode took ${ms.toFixed(0)} ms`);
});
