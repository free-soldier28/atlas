// global scene constants, interpolated into shaders (WATER, PULSE, SUN) and used by camera code.
// Replaces Atlantis's layout.js: no procedural city plan here — the world comes from the pack.
// POSES/FLY are defaults; a pack's header poses/fly override them at load (world.js).
const WATER = 0.5; // water plane height in metres (pack layers may override per area)
const PULSE = 12;  // seconds between beats of the energy pulse (kept: shaders interpolate it)
const SEA_GROW = 1.034; // kept: sh_scene interpolates the swell's fade from it (the sea mesh builder is gone)
const SUN = vnorm([-0.91, 0.171, -0.33]); // towards the sun: golden hour, west-north-west
const angd = (a, b) => { let d = (a - b) % TAU; if (d > PI) d -= TAU; if (d < -PI) d += TAU; return d; };
// default viewpoints (keys 1-6): pack header.poses replaces this array at load (`let`: main.js swaps it in)
let POSES = [
  [-220, 120, 220, 0, 0, 0],
  [0, 6, 160, 0, 14, 0],
  [160, 40, -160, 0, 10, 0],
  [0, 260, 480, 0, 0, 0],
  [-160, 12, 60, 0, 18, 0],
  [40, 30, 220, 0, 6, 0],
];
// default fly-through: one slow lap around the pack centre (pack header.fly replaces it, `let` like POSES)
let FLY = (() => {
  const N = 12, a = new Float32Array(N * 6);
  for (let i = 0; i < N; i++) {
    const t = i / N * TAU, r = 260 - 80 * (0.5 + 0.5 * sin(t * 2));
    a[i * 6] = cos(t) * r; a[i * 6 + 1] = 40 + 25 * sin(t * 3); a[i * 6 + 2] = sin(t) * r;
    a[i * 6 + 3] = 0; a[i * 6 + 4] = 6; a[i * 6 + 5] = 0;
  }
  return a;
})();
