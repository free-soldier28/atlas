# Architecture

Atlas = **engine** (one HTML, raw WebGPU) + **map packs** (`.mpk`, one file per city or country layer).
The single shared contract is `docs/mpk-format.md`; the encoder and decoder references implement it
(`pipeline/lib/pack.mjs`, `source/src/format.js`).

## Scaling model

| Layer | What | How it loads |
|---|---|---|
| Engine | renderer, UI, loader | always present, ~100 KB |
| City pack | full detail of one city (tiles 512 m, 3 content LODs, CSR routing graph) | loaded whole on entering the city; GPU buffers disposed on leaving |
| Country pack | coarse layer of a country (highways, water, city markers, routable highway graph) | streamed tile-by-tile as the camera moves (range requests into the archive) |
| World | the set of packs in `packs/manifest.json` | engine streams whatever is in the camera's zone |

Adding a city or country = building a pack + one manifest line. No engine code changes.

## Two view modes (profiles)

- **overview** — country/world scale, shows the whole route, city markers (future)
- **street** — street-level 3D, vehicle-follow camera (this is what the MVP builds)

Both share the tile format and the render pipeline; only the camera, LOD mix and overlays differ.
Route start later = animated transition overview → street.

## Engine pipeline (inherited from Atlantis)

Deferred G-buffer → compute-pass GPU culling + LOD per instance (indirect draws) →
cascaded + baked sun shadows → GTAO → deferred light → transparency (water/glass) →
TAA → bloom → AgX tone mapping. Fixed sun; sky/IBL baked once at load. Zero per-frame
allocations. Dynamic resolution scaling; quality auto-demotion on device loss.

The instance system is data-driven: 48-byte instances (position, quaternion, tint, mesh type,
radius, y-scale) referencing a finite mesh-type table — external geometry plugs in unchanged.
Buildings render as per-tile chunk meshes; a later pass adds archetype instancing for facades.

## Navigation (the part that comes later, kept cheap now)

- The road graph ships inside city packs (CSR: junction nodes + edges with length/class/oneway/speed).
- Country packs hold the highway graph; connector edges join city graphs at boundaries → inter-city A*.
- GPS: `setVehiclePose(lat, lon, heading)` → local frame → snap to nearest edge → vehicle marker +
  follow camera. The same entry point serves the simulator, DevTools mocking and real GPS.

## Module map (source/src/, concatenation order matters)

| Module | Role |
|---|---|
| math.js | seeded RNG, noise, linalg, the MB mesh builder (20-byte vertices) |
| quality.js | adapter selection, detail levels, crash demotion |
| format.js | MPK v1 decoder (pure JS, node-testable) |
| loader.js | pack source (fetch/embedded), world lifecycle, setVehiclePose |
| globals.js | shader-interpolated constants (WATER/PULSE/SUN), default poses/fly |
| sh_base.js | common WGSL: View struct, sky, environment, atmosphere bake |
| sh_scene.js | GPU culling + LOD + indirect instancing, G-buffer materials |
| sh_light.js | shadows lib, GGX, AO, light shafts, TAA, bloom, AgX post |
| sh_fx.js | water SSR/refraction, glass, crystal (city packs later decide what to use) |
| world.js | mesh/instance registry + pack → world build |
| collide.js | camera collision (flat ground + building volumes) |
| main.js | device, passes, resize, frame loop, input |
| dev.js | fly-through, benchmark, screenshot/count tools (dev build only) |
| music.js | chiptune (untouched) |
