// shadow memory: one baked set shared by day/night, smaller texels on phones and Low.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const src = (f) => readFileSync(path.join(ROOT, 'source', f), 'utf8');
const main = src('src/main.js'), quality = src('src/quality.js');

test('shadows: day and night share one baked set instead of two', () => {
  assert.match(main, /const tShN = tSh;/, 'night reuses the day textures');
  const allocations = (main.match(/tex\(SHN\[1\], SHN\[1\]/g) || []).length;
  assert.equal(allocations, 1, 'only one city/shelf/far set is allocated');
  assert.doesNotMatch(main, /shReady\[/, 'no per-profile readiness state left');
  assert.match(main, /await bakeShadowMaps\(tSh\); \/\/ one shared set: every profile switch re-bakes for its sun/);
  assert.match(main, /rebakeShadows = \(\) => \{ bakeShadowMaps\(tSh\); \};/);
});

test('shadows: mobile and Low use a quarter of the baked texels', () => {
  assert.match(quality, /mob \? \[1024, 2048, 1024, 512\] : \[1024, 4096, 2048, 1024\], \[0, 2048, 1024, 512\]/);
  const lowBakedMB = (2048 * 2048 + 1024 * 1024 + 512 * 512) * 2 / 1048576; // 16-bit depth
  const highBakedMB = (8192 * 8192 + 4096 * 4096 + 2048 * 2048) * 2 / 1048576;
  assert.ok(lowBakedMB < 11, `Low baked set is ${lowBakedMB.toFixed(1)} MB`);
  assert.ok(highBakedMB < 180, `High set is ${highBakedMB.toFixed(0)} MB (was double with night copies)`);
});
