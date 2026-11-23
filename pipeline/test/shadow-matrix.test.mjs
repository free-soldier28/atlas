// shadowMat contract tests — the shadow-flicker regression. The startup bake wrote the far-map
// matrices into the shadow view only (views=false) while the light pass reads them from the main
// view: far shadows then existed only inside the camera cascade and flickered as it swept.
// These tests pin: (1) views=true copies into BOTH uniform views, (2) views=false leaves the main
// copy alone (bake contract), (3) texel snapping makes sub-texel camera moves produce identical
// matrices (no crawl), (4) the depth box maps onto the map's z range, (5) cull planes reject
// points outside the box. The functions are extracted from main.js verbatim so the test breaks
// when the engine's implementation drifts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');
const src = readFileSync(path.join(ROOT, 'source', 'src', 'main.js'), 'utf8');

const planeSrc = src.match(/function plane\(U, k, nx, ny, nz, px, py, pz, w\) \{.*\}/)?.[0];
const smSrc = src.match(/function shadowMat\(at, cx, cy, cz, R, d0, d1, size, cull, views = true\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(planeSrc, 'plane() not found in main.js');
assert.ok(smSrc, 'shadowMat() not found in main.js');

const vnorm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// one engine instance with the given light basis, mirroring main.js lines 116-117
const makeEngine = (sun) => {
  const NU = 216, V_MAIN = 0, V_SH = 1, O_PL = 144, O_SM = 48;
  const UB = [new Float32Array(NU), new Float32Array(NU)];
  const LR = vnorm([sun[2], 0, -sun[0]]), LU = vcross(sun, LR);
  const fns = new Function('UB', 'V_MAIN', 'V_SH', 'O_PL', 'LR', 'LU', 'ACTIVE_SUN', 'round',
    `${planeSrc}\n${smSrc}\nreturn { plane, shadowMat };`)(UB, V_MAIN, V_SH, O_PL, LR, LU, sun, Math.round);
  return { UB, V_MAIN, V_SH, O_PL, O_SM, LR, LU, SUN: sun, ...fns };
};
const DAY = vnorm([-0.91, 0.171, -0.33]);              // globals.js SUN
const NIGHT = vnorm([-DAY[0], 1, -DAY[2]]);            // globals.js NIGHT_SUN
const slice = (U, at) => Array.from(U.slice(at, at + 16));
const matAt = (E, view, at, x, y, z) => { // apply the 4x4 at `at` of that view (col-major floats)
  const m = E.UB[view];
  return [0, 1, 2, 3].map((r) => m[at + r] * x + m[at + 4 + r] * y + m[at + 8 + r] * z + m[at + 12 + r]);
};

test('views=true writes the map matrix into BOTH the shadow view and the main view', () => {
  const E = makeEngine(DAY);
  E.shadowMat(E.O_SM + 16, 0, 0, 0, 480, -900, 900, 4096, false, true);
  const sh = slice(E.UB[E.V_SH], E.O_SM + 16), mn = slice(E.UB[E.V_MAIN], E.O_SM + 16);
  assert.ok(sh.some((v) => v !== 0), 'shadow view must receive the matrix');
  assert.deepEqual(mn, sh, 'light pass reads view.sm from the MAIN view: it must get the same matrix');
});

test('views=false (bake contract) leaves the main view copy untouched', () => {
  const E = makeEngine(DAY);
  E.shadowMat(E.O_SM + 16, 0, 0, 0, 480, -900, 900, 4096, false, false);
  assert.ok(slice(E.UB[E.V_SH], E.O_SM + 16).some((v) => v !== 0), 'shadow view must be written');
  assert.deepEqual(slice(E.UB[E.V_MAIN], E.O_SM + 16), new Array(16).fill(0),
    'bakes run while the active profile is on screen — the main copy must stay alone');
});

test('regression: the startup bake+copy sequence ends with all three far maps present in the main view', () => {
  const E = makeEngine(DAY);
  const SHN = [0, 4096, 4096, 4096];
  // the old bake: views=false only — this is exactly what left the main view at zero
  E.shadowMat(E.O_SM + 16, 0, 0, 0, 480, -900, 900, SHN[1], true, false);
  E.shadowMat(E.O_SM + 32, 0, 0, 0, 1400, -2600, 2600, SHN[2], true, false);
  E.shadowMat(E.O_SM + 48, 0, 0, 0, 6800, -9000, 9000, SHN[3], true, false);
  for (const at of [E.O_SM + 16, E.O_SM + 32, E.O_SM + 48])
    assert.ok(slice(E.UB[E.V_MAIN], at).every((v) => v === 0), 'bake alone must not touch the main view');
  // the fix: after the bake, rewrite each map with views=true so the light pass sees the matrices
  E.shadowMat(E.O_SM + 16, 0, 0, 0, 480, -900, 900, SHN[1], true);
  E.shadowMat(E.O_SM + 32, 0, 0, 0, 1400, -2600, 2600, SHN[2], true);
  E.shadowMat(E.O_SM + 48, 0, 0, 0, 6800, -9000, 9000, SHN[3], true);
  for (const at of [E.O_SM + 16, E.O_SM + 32, E.O_SM + 48]) {
    const mn = slice(E.UB[E.V_MAIN], at), sh = slice(E.UB[E.V_SH], at);
    assert.ok(mn.some((v) => v !== 0), `far map at ${at} must reach the main view`);
    assert.deepEqual(mn, sh);
  }
});

test('texel snap: sub-texel camera moves produce identical matrices (no crawl)', () => {
  const E = makeEngine(DAY);
  const R = 46, size = 1024, tx = 2 * R / size; // the per-frame cascade
  // snapping quantizes the center in LIGHT space (px = round(LR·C / tx)·tx, same for LU). Place the
  // center exactly on a texel center (solve the 2x2 in the LR/LU basis), then drift half a texel
  // minus epsilon along LR: neither px nor py crosses a rounding boundary, the matrix must not move.
  const place = (k, m, cy = 40) => { // light-space (k·tx, m·tx) → world (cx, cy, cz)
    const u = k * tx, w = m * tx - E.LU[1] * cy;
    const det = E.LR[0] * E.LU[2] - E.LR[2] * E.LU[0];
    return [(u * E.LU[2] - E.LR[2] * w) / det, cy, (E.LR[0] * w - E.LU[0] * u) / det];
  };
  const [cx, cy, cz] = place(766, 512), lr = E.LR, eps = 0.45;
  E.shadowMat(E.O_SM, cx, cy, cz, R, -420, 700, size, false, true);
  const m0 = slice(E.UB[E.V_MAIN], E.O_SM);
  E.shadowMat(E.O_SM, cx + lr[0] * tx * eps, cy, cz + lr[2] * tx * eps, R, -420, 700, size, false, true);
  assert.deepEqual(slice(E.UB[E.V_MAIN], E.O_SM), m0, `a ${eps}-texel drift must not change the map`);
  E.shadowMat(E.O_SM, cx + lr[0] * tx * 8, cy, cz + lr[2] * tx * 8, R, -420, 700, size, false, true);
  const m1 = slice(E.UB[E.V_MAIN], E.O_SM);
  assert.notDeepEqual(m1, m0, 'a multi-texel move must still follow the camera');
  // the translation row moved by whole texels: |Δ·R| is a multiple of tx
  const d = Math.hypot((m1[12] - m0[12]) * R, (m1[13] - m0[13]) * R);
  assert.ok(Math.abs(d / tx - Math.round(d / tx)) < 1e-4, `translation stepped ${d / tx} texels, must be whole`);
});

test('depth box maps to the map z range: center depth lands mid-range, ends land on the boundaries', () => {
  const E = makeEngine(DAY);
  const [cx, cy, cz] = [0, 100, 0], R = 480, d0 = -900, d1 = 900, D = d1 - d0;
  E.shadowMat(E.O_SM + 16, cx, cy, cz, R, d0, d1, 4096, false, true);
  const C = [cx, cy, cz];
  const sz = (p) => matAt(E, E.V_MAIN, E.O_SM + 16, ...p)[2];
  const along = (d) => [cx + E.SUN[0] * d, cy + E.SUN[1] * d, cz + E.SUN[2] * d];
  assert.ok(Math.abs(sz(C) - d1 / D) < 1e-6, 'box-center depth must map to (d1 + pz - pz)/D');
  assert.ok(Math.abs(sz(along(d0)) - 1) < 1e-6, 'near depth d0 maps to z=1');
  assert.ok(Math.abs(sz(along(d1)) - 0) < 1e-6, 'far depth d1 maps to z=0');
  assert.ok(sz(along((d0 + d1) / 2)) > 0 && sz(along((d0 + d1) / 2)) < 1, 'inside the box stays inside the map');
});

test('lateral box maps to the map xy range with texel-snap slack', () => {
  const E = makeEngine(DAY);
  const C = [0, 100, 0], R = 480, size = 4096;
  E.shadowMat(E.O_SM + 16, ...C, R, -900, 900, size, false, true);
  const sx = (p) => matAt(E, E.V_MAIN, E.O_SM + 16, ...p)[0];
  const sy = (p) => matAt(E, E.V_MAIN, E.O_SM + 16, ...p)[1];
  const tol = 1 + 2 / size; // snapping shifts the box by at most a texel
  for (const [n, s] of [['LR', E.LR], ['LU', E.LU]]) {
    const at = (k) => [C[0] + s[0] * R * k, C[1] + s[1] * R * k, C[2] + s[2] * R * k];
    assert.ok(Math.abs(sx(at(1))) <= tol && Math.abs(sy(at(1))) <= tol, `${n} edge must land on the map border`);
    assert.ok(Math.abs(sx(at(-1))) <= tol && Math.abs(sy(at(-1))) <= tol, `-${n} edge must land on the map border`);
    assert.ok(Math.abs(sx(C)) < 1e-3, 'box center projects near the map origin');
  }
});

test('cull planes: the box center is inside, points past the R wall are rejected', () => {
  const E = makeEngine(DAY);
  const C = [0, 100, 0];
  E.shadowMat(E.O_SM + 16, ...C, 480, -900, 900, 4096, true, true);
  const dist = (p, k) => { // plane k of the shadow view's own header
    const m = E.UB[E.V_SH], o = E.O_PL + k * 4;
    return m[o] * p[0] + m[o + 1] * p[1] + m[o + 2] * p[2] + m[o + 3];
  };
  for (let k = 0; k < 4; k++) assert.ok(dist(C, k) > 0, `center inside cull plane ${k}`);
  const out = [C[0] + E.LR[0] * 3 * 480, C[1] + E.LR[1] * 3 * 480, C[2] + E.LR[2] * 3 * 480];
  assert.ok(dist(out, 1) < 0, 'a point 3R along LR must be culled by the -LR plane');
});

test('the active-light swap changes the basis: night matrices differ from day for the same box', () => {
  const D1 = makeEngine(DAY), E2 = makeEngine(NIGHT);
  D1.shadowMat(D1.O_SM + 16, 0, 0, 0, 480, -900, 900, 4096, false, true);
  E2.shadowMat(E2.O_SM + 16, 0, 0, 0, 480, -900, 900, 4096, false, true);
  assert.notDeepEqual(slice(D1.UB[0], D1.O_SM + 16), slice(E2.UB[0], E2.O_SM + 16),
    'ACTIVE_SUN/LR/LU drive the matrix — a swapped profile must not reuse the day basis');
});
