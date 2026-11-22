// collision: what the camera cannot fly into. v0 pack world: flat ground at y 0 everywhere, plus the buildings
// as floor boxes (stand on the roof, step blocked at the edge). No walls of their own yet — the per-axis retry
// in collide1 does the blocking. surfaceAt runs every frame; no allocation.
const CLEAR = 0.9, CLEAR_W = 0.55; // clearance above solid ground, and above water
const COL = new Float64Array(3); // last query: floor, ceiling, 1 where the floor is natural ground or water
let landY = null; // set by main.js once the world is built (0: the pack frame is flat)
// building boxes from world.js: [x0, z0, x1, z1, top] flat. `setHard` kept for the old API; the Atlantis
// dome/hall/villa shape lists are gone — the boxes carry everything.
let BX = null;
function setHard(h) { }
function setBoxes(b) { BX = b; }
// floor under (x, z): the highest box the point is inside, else flat ground. y0 decides nothing yet (v0 has no
// under-roof space), a point above a roof still lands on it.
function surfaceAt(x, z, y0) {
  COL[1] = 1e9; COL[2] = 1;
  let f = 0;
  if (BX) for (let i = 0; i < BX.length; i += 5) if (x > BX[i] && x < BX[i + 2] && z > BX[i + 1] && z < BX[i + 3] && BX[i + 4] > f) { f = BX[i + 4]; COL[2] = 0; }
  COL[0] = f + CLEAR;
}
// move the camera from (px, py, pz) towards F[CX..CZ] (velocity F[VX..VZ]), correcting both in place. Natural ground
// lifts it; anything built higher than a stair step is a wall it slides along per axis. Long steps go in <= 2 m pieces.
function collide(px, py, pz) {
  if (!landY) return;
  const tx = F[CX], ty = F[CY], tz = F[CZ], n = min(16, ceil(hypot(tx - px, tz - pz) / 2));
  if (n < 2) { collide1(px, py, pz); return; }
  let cx = px, cy = py, cz = pz, dx = (tx - px) / n, dz = (tz - pz) / n; const dy = (ty - py) / n;
  for (let i = 0; i < n; i++) {
    F[CX] = cx + dx; F[CY] = cy + dy; F[CZ] = cz + dz; collide1(cx, cy, cz);
    if (F[CX] === cx) dx = 0; if (F[CZ] === cz) dz = 0; // an axis that hit a wall stays there
    cx = F[CX]; cy = F[CY]; cz = F[CZ];
  }
}
function collide1(px, py, pz) {
  let x = F[CX], y = F[CY], z = F[CZ];
  const lift = 0.5 + 1.5 * hypot(x - px, z - pz);
  surfaceAt(x, z, py);
  if (COL[2] < 0.5 && COL[0] - y > lift) {
    surfaceAt(x, pz, py);
    if (COL[2] > 0.5 || COL[0] - y <= lift) { z = pz; F[VZ] = 0; }
    else {
      surfaceAt(px, z, py);
      if (COL[2] > 0.5 || COL[0] - y <= lift) { x = px; F[VX] = 0; }
      else { x = px; z = pz; F[VX] = 0; F[VZ] = 0; surfaceAt(x, z, py); }
    }
  }
  if (y < COL[0]) { y = COL[0]; if (F[VY] < 0) F[VY] = 0; } else if (y > COL[1]) { y = COL[1]; if (F[VY] > 0) F[VY] = 0; }
  F[CX] = x; F[CY] = y; F[CZ] = z;
}
