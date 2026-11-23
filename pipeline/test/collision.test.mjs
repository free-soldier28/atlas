// collision debug toggle: "Walk through buildings" disables only building boxes (ground/water
// collision and the global Collision button stay independent); default off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const src = (f) => readFileSync(path.join(ROOT, 'source', f), 'utf8');

test('ghost mode gates building boxes only', () => {
  const c = src('src/collide.js');
  assert.match(c, /let boxesOn = true/, 'collision on by default');
  assert.match(c, /function setBoxCollision\(on\) \{ boxesOn = !!on; \}/, 'setter present');
  assert.match(c, /if \(BX && boxesOn\) for \(let i = 0; i < BX\.length; i \+= 5\)/, 'surfaceAt honours the gate');
  const m = src('src/main.js');
  assert.match(m, /let ghost = 0;/, 'debug toggle defaults to off');
  assert.match(m, /setBoxCollision\(!ghost\);/, 'startup applies the setting');
  assert.match(m, /window\.__ghost = setGhost/, 'headless setter available');
  assert.match(m, /if \(\$\('gw'\)\) \$\('gw'\)\.onclick = \(\) => setGhost\(\)/, 'drawer button wired');
  const html = src('template.html');
  assert.match(html, /id=gw/, 'drawer row present');
});
