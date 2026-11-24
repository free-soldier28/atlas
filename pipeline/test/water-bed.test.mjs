// inland water must not refract the city lawn plane ("green glass"): fsWater replaces the
// sampled scene behind with a silt/gravel bed before the absorption term, for kind 0 only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const src = readFileSync(path.join(ROOT, 'source', 'src', 'sh_fx.js'), 'utf8');

test('fsWater overrides the refracted bed for inland water', () => {
  const body = src.slice(src.indexOf('@fragment fn fsWater'), src.indexOf('@fragment fn', src.indexOf('@fragment fn fsWater') + 10));
  const sample = body.indexOf('var under = textureSampleLevel');
  const override = body.indexOf('under = mix(', sample);
  const absorb = body.indexOf('under = under * exp(', sample);
  assert.ok(sample > 0, 'the scene behind is still sampled');
  assert.ok(override > sample && override < absorb, 'bed colour is replaced before absorption');
  const block = body.slice(body.indexOf('if (kind == 0u) {', sample), absorb);
  assert.match(block, /bedN\.r \* \.75 \+ grit\.g \* \.25/, 'bed is broken up at two noise scales');
  assert.match(block, /shw/, 'the bed is shadowed');
});

test('other water kinds keep refracting the scene behind', () => {
  const body = src.slice(src.indexOf('@fragment fn fsWater'));
  assert.match(body, /if \(kind == 1u\) \{ sig =/, 'light-liquid profile intact');
  assert.match(body, /else \{ sig = vec3f\(\.4, \.08, \.06\)/, 'sea profile intact');
});

test('fsWater uses view-depth units for the water surface depth', () => {
  const body = src.slice(src.indexOf('@fragment fn fsWater'));
  assert.match(body, /let zw = max\(i\.clip\.w, \.1\)/, 'clip.w is view depth in metres, like viewZ');
  assert.doesNotMatch(body, /zw = 1\. \/ i\.clip\.w/, 'the old reciprocal made absorption erase the bed');
});
