// global scene constants, interpolated into shaders (WATER, SUN) and used by camera code.
// Replaces Atlantis's layout.js: no procedural city plan here — the world comes from the pack.
// POSES/FLY are defaults; a pack's header poses/fly override them at load (world.js).
const WATER = 0.04; // pack water plane: below roads (0.06) and above green polys (0.03) — streams pass
// under streets, the river under bridges, and a building's base sits 4 cm into it, not half a metre
const SEA = false; // the Atlantis sea plane at the origin (its caustics and water glow) — city packs have
// no sea; terrain packs restore it together with the sea's mesh builder
const SEA_GROW = 1.034; // kept: the sea swell's fade in sh_scene interpolates from it (terrain packs bring the mesh)
const SUN = vnorm([-0.91, 0.171, -0.33]); // towards the sun: golden hour, west-north-west
// towards the moon: ~45 deg up, azimuth opposite the day sun (night profile: main.js bakes a second sky with it)
const NIGHT_SUN = vnorm([-SUN[0], 1, -SUN[2]]);
const MOONTINT = [0.8, 0.9, 1.2]; // moonlight colour: red cut, blue lifted
// night bake scales vs the day bake. Strict physics (moonlight 1/4e4 of the sun) renders black under AgX at the night
// exposure (see main.js): these are art-directed film-night levels, tuned so streets and facades read dark-blue
// while the sky stays near-black (the light pass adds a small blue ambient floor on top of the direct moon).
const MOONGROUND = 2e-2; // moon illuminance at the ground, x E0 (~1/60 of the day sun)
const MOONSKY = 1.4e-2;  // the night sky table's brightness vs its march output
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
