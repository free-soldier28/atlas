# Atlas

**A real-city 3D map renderer for the browser, in the spirit of [Atlantis](https://github.com/Noniv/atlantis): raw WebGPU, no engines, no libraries, one HTML file — but for actual places, built for car navigation.**

The engine is small (~100 KB); the places live in **map packs** (`packs/*.mpk`) generated from OpenStreetMap. The first city is **Grodno, Belarus**. The format is tile-based and scale-free: the same layout serves a city pack (full detail) and a country pack (coarse, streamed by range requests), so the map grows city by city and country by country without engine changes.

![status: work in progress](https://img.shields.io/badge/status-work%20in%20progress-orange)

## Run it

Needs Chrome or Edge with WebGPU, Node.js ≥ 18 to build.

```bash
cd source && npm install && npm run build     # bundles src/*.js into ../index.html
node pipeline/mksample.mjs                    # synthetic test pack (no network)
node pipeline/fetch.mjs && node pipeline/build-city.mjs   # real Grodno pack (one-time Overpass extract)
node source/build.mjs --pack=packs/grodno.mpk             # embed a pack for offline file:// use
```

Open `index.html` (or serve the folder and open with `?city=grodno` to fetch the pack at runtime).

## Layout

```
docs/mpk-format.md    the pack format: the one contract every module and script shares
pipeline/             fetch.mjs (Overpass extracts, cached) · build-city.mjs (pack builder) ·
                      lib/pack.mjs (encoder) · mksample.mjs (synthetic test pack) · test/ (node --test)
source/src/           the engine: math, quality, format (mpk reader), loader, world, collide, main,
                      sh_* (WGSL deferred pipeline: culling/instancing, AO, light, TAA, bloom, AgX)
packs/                manifest + built packs
```

## Roadmap

1. **Engine on packs** — ground/buildings/roads/water/green rendered from a pack, flat-ground collision *(in progress)*
2. **Grodno pack** — Overpass → tiles + routing graph *(in progress)*
3. **Day/night** — moonlit night with lit windows and street lamps; golden-hour day *(planned)*
4. **Streaming + GPS** — worker tile decode, LRU GPU cache, city switcher, GPS position with snap-to-road *(planned)*
5. **Overview mode** — country/world view showing the whole route; dive into street view on route start *(planned)*
6. **Routing** — A* over the hierarchical graph (city + country highways), route line, maneuvers *(planned)*

The routing graph ships inside city packs from day one — navigation reads what the renderer draws.

## Sources & licenses

- Map data © OpenStreetMap contributors (ODbL)
- Terrain (planned): Copernicus GLO-30 DEM
- Engine base: parts ported from [Atlantis](https://github.com/Noniv/atlantis) (MIT)
- This repo: MIT — see [LICENSE](LICENSE)
