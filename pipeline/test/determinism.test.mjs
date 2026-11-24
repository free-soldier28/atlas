// determinism: pipeline/build-city.mjs rebuilt twice from the caches must produce byte-identical
// packs (fixed seeds, sorted tiles, stable string interning — any order- or float-drift in the
// build shows up here). The pack is restored to its original bytes afterwards whatever happens,
// so the working tree stays exactly as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCache } from './helpers.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACK = path.join(root, 'packs/grodno.mpk');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

test('determinism: two build-city runs → identical hashes, pack left byte-identical', (t) => {
  if (!hasCache('roads') || !hasCache('buildings')) return t.skip('OSM cache not present; run pipeline/fetch.mjs');
  const keep = mkdtempSync(path.join(tmpdir(), 'atlas-det-'));
  const saved = path.join(keep, 'grodno.mpk');
  copyFileSync(PACK, saved); // the original, to restore + compare against
  const orig = sha(saved);
  const run = () => spawnSync(process.execPath, [path.join(root, 'pipeline/build-city.mjs')], { timeout: 120000, encoding: 'utf8' });
  try {
    const r1 = run();
    assert.equal(r1.status, 0, `build-city run 1 failed: ${r1.stderr || r1.stdout}`);
    const h1 = sha(PACK);
    const r2 = run();
    assert.equal(r2.status, 0, `build-city run 2 failed: ${r2.stderr || r2.stdout}`);
    const h2 = sha(PACK);
    assert.equal(h1, h2, `build-city output not deterministic:\n  run 1 ${h1}\n  run 2 ${h2}`);
    assert.equal(h1, orig, `rebuilt pack differs from the original bytes:\n  original ${orig}\n  rebuilt  ${h1}`);
  } finally {
    writeFileSync(PACK, readFileSync(saved));
    assert.equal(sha(PACK), orig, 'pack restore failed — packs/grodno.mpk was left modified');
    rmSync(keep, { recursive: true, force: true });
  }
});
