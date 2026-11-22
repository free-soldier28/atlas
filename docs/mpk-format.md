# MPK v2 — map pack format

The contract between the data pipeline (`pipeline/`) and the engine (`source/src/`).
One `.mpk` file = one pack (a city, a country layer, a synthetic test world).
Encoder reference: `pipeline/lib/pack.mjs`. Decoder reference: `source/src/format.js`.
**Changing this file requires changing both references and bumping `v` in the header.**
v1→v2: building records gained `osmId` (u32) and `src` (u8 provenance bits); the decoder
still reads v1 (fields default to 0) so old packs load until rebuilt.

## File layout

```
bytes 0..3    magic "MPK1" (u32 LE 0x314B504D)
bytes 4..7    u32 LE  headerByteLen
bytes 8..     header: JSON (UTF-8, no padding)
then          tile / graph / terrain blobs, back to back, at absolute offsets
```

## Header JSON

```jsonc
{
  "v": 2,                  // format version
  "id": "grodno",          // stable pack id (file name, ?city= value)
  "name": "Гродно",         // display name
  "attribution": "© OpenStreetMap contributors",
  "origin": [53.6784, 23.8291],   // [lat, lon]: centre of the local metre frame
  "tileSize": 512,         // tile edge in metres
  "bbox": [53.62, 23.70, 53.76, 23.96],  // [minLat, minLon, maxLat, maxLon]
  "strings": ["Праспект Леніна", ...],   // street/POI names, referenced by index
  "tiles": [[tx, tz, off, len], ...],    // tile coords (in tiles from origin), blob offset/len in the file
  "graph": {"off": 0, "len": 0} | null,  // routing graph blob (city packs)
  "terrain": {"off": 0, "len": 0, "cell": 40, "nx": 512, "nz": 512} | null,  // height grid, i16 decimetres
  "poses": [[x,y,z, tx,ty,tz], ...] | null,  // camera viewpoints (keys 1..6), metres, local frame
  "fly": [x,y,z, tx,ty,tz, ...] | null       // scripted fly-through spline, 2.5 s per point
}
```

## Coordinates

Local frame: metres, +X east, −Z north, +Y up (matches the renderer). From lat/lon:
`x = (lon − lon0) · cos(lat0) · 111320`, `z = −(lat − lat0) · 111320`.
Tile `(tx, tz)` covers `x ∈ [tx·S, (tx+1)·S)`, `z ∈ [tz·S, (tz+1)·S)`, `S = tileSize`.
Quantization inside a tile: **Int32 centimetres, tile-local**. Heights: `i16` decimetres.
A country pack uses the same layout — its tiles are sparse (empty ones are simply absent)
and its content is coarse; the engine streams tiles by camera position, so the identical
format serves both scales.

## Tile blob

`deflate-raw` of:

```
u8  nLod                      // content levels, 0 = coarsest (far view), nLod-1 = full
per LOD:
  u8  nLayers
  per layer:
    u8  kind                  // 1 buildings, 2 roads, 3 water, 4 green, 5 terrainPatch
    u32 nRec
    per record, by kind:
      buildings: u16 nPts, u8 bkind, u8 roof, i16 h10, i16 base10, u32 osmId, u8 src, i32 pts[nPts*2]
                 // h10: roof top above ground in 0.1 m; base10: base above ground;
                 // bkind: building type code; roof: 0 flat, 1 gable, 2 hip (rendered flat in v1);
                 // osmId: OSM way/relation id — the improvement loop's address of this building;
                 // src provenance bits: 0-1 height source (0 prior/default estimate, 1 levels×3.2,
                 //   2 real height tag), 2 roof:shape tagged, 3 colour tagged, 4 osmId is a relation,
                 //   5-7 reserved — the analysis tools read these (pipeline/report.mjs)
      roads:     u8 cls, u8 flags, u16 name, u8 lanes, i16 w10, u16 nPts, i32 pts[nPts*2]
                 // cls: 0 motorway,1 trunk,2 primary,3 secondary,4 tertiary,5 residential,
                 //      6 unclassified/living,7 service,8 pedestrian,9 footway,10 path;
                 // flags bit0 oneway; w10: full width in 0.1 m (0 = use cls default)
      water/green: u8 kind, u16 nPts, i32 pts[nPts*2]
                 // water kind: 0 river, 1 lake, 2 canal, 3 pond; green kind: 0 park,1 forest,2 grass
      terrainPatch: u8 cell, u8 n, i16 h[n*n]   // decimetres, row-major, local to the tile's corner
```

## Graph blob (routing, city packs)

`deflate-raw` of:

```
u32 nNodes; per node: i32 x, i32 z          // cm, pack-local (junctions only)
u32 nEdges; per edge:
  u32 a, u32 b                               // node indices (a < b; undirected unless flags bit0)
  u8 cls, u8 flags, u16 name, u8 lanes, u16 speed, u32 len
  // speed: km/h; len: metres (used directly by A*, no recompute)
```

Directed edges (oneway) are listed twice if reverse travel is allowed, once if not.
Cross-city routes later: a country pack's graph holds the same structure for its
highways; connector edges join country nodes to city-graph boundary nodes (pipeline
duty, engine just walks edges).

## Conventions

- `name` is an index into `header.strings`; 0 = unnamed.
- Records may be listed in any order; the engine never assumes sorting.
- Unknown layer kinds / bkind codes must be skipped, not fatal: packs are forward-compatible.
- Tile coords can be negative (city origin inside the bbox).
- All integers little-endian, packed (no alignment padding).
