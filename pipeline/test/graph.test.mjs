// graph: node indices in range, edge len > 0, name indices valid, junction detection
// sane (≥500 nodes for a city this size), largest connected component ≥90% of nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPack } from './helpers.mjs';

test('graph: sane edges, ≥500 junction nodes, largest component ≥90%', async () => {
  const P = await openPack(false);
  const G = await globalThis.mpkGraph(P);
  const n = G.nx.length, e = G.ea.length;
  assert.ok(n >= 500, `only ${n} junction nodes`);
  assert.ok(e > 0, 'no edges');
  for (let i = 0; i < e; i++) {
    assert.ok(G.ea[i] < n && G.eb[i] < n, `edge ${i}: node index out of range`);
    assert.ok(G.ea[i] !== G.eb[i], `edge ${i}: self loop`);
    assert.ok(G.elen[i] > 0, `edge ${i}: zero length`);
    assert.ok(G.espeed[i] > 0 && G.espeed[i] <= 130, `edge ${i}: speed ${G.espeed[i]}`);
    assert.ok(G.ename[i] < P.h.strings.length, `edge ${i}: name index out of range`);
    assert.ok(G.ecls[i] <= 6, `edge ${i}: non-drivable class ${G.ecls[i]} in graph`);
  }
  // undirected connectivity
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < e; i++) { adj[G.ea[i]].push(G.eb[i]); adj[G.eb[i]].push(G.ea[i]); }
  const seen = new Uint8Array(n);
  let largest = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    let size = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) { const v = stack.pop(); size++; for (const w of adj[v]) if (!seen[w]) { seen[w] = 1; stack.push(w); } }
    largest = Math.max(largest, size);
  }
  console.log(`graph: ${n} nodes, ${e} edges, largest component ${largest} (${(100 * largest / n).toFixed(1)}%)`);
  assert.ok(largest >= 0.9 * n, `largest component ${largest}/${n} < 90%`);
});
