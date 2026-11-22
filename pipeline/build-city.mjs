// builds packs/grodno.mpk from the Overpass caches produced by pipeline/fetch.mjs.
// Projection: geoToLocal() metres about the pack origin, quantized to Int32 centimetres, tile-local.
//
// v1 simplifications (kept deliberately, both logged at build time):
//  - building multipolygon relations: outer rings only, inner (hole) rings are dropped;
//  - water: no width stored (renderer decides); graph: drivable classes 0..6 only
//    (service roads render but do not route).
// Node usage: node pipeline/build-city.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MPKBuilder, geoToLocal } from './lib/pack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const readCache = (n) => JSON.parse(readFileSync(path.join(here, 'cache', `${n}.json`), 'utf8')).elements;

const ID = 'grodno', NAME = 'Гродно';
const ORIGIN = [53.6784, 23.8291];            // [lat0, lon0] — the local metre frame
const BBOX = [53.62, 23.70, 53.76, 23.96];    // [minLat, minLon, maxLat, maxLon]
const S = 512, CM = 100;                      // tile edge m, metres→cm
const L = (lat, lon) => geoToLocal(lat, lon, ORIGIN[0], ORIGIN[1]); // → [x east, z south] metres

// ---------- tag interpretation ----------

// first number of "12 m" / "12.5" / "12,5" → metres, NaN if absent
const num = (t) => { const m = /-?\d+(?:[.,]\d+)?/.exec(String(t)); return m ? parseFloat(m[0].replace(',', '.')) : NaN; };

const RESIDENTIAL = new Set(['house', 'detached', 'residential', 'apartments', 'semidetached_house', 'terrace', 'terraced_house', 'duplex', 'bungalow', 'dormitory', 'residential;apartments']);
const LEVELS_TALL = new Set(['office', 'retail', 'commercial', 'industrial', 'public', 'church']); // × 3.6 m/level
const CHURCHY = new Set(['church', 'cathedral', 'chapel', 'basilica', 'temple', 'mosque', 'synagogue']);
const PRIOR = { garages: 3, garage: 3, shed: 2.5, hut: 2.5, house: 6, detached: 6, bungalow: 4, apartments: 16, church: 15, cathedral: 15 }; // type priors, m

function buildingHeight(tags) {
  const b = (tags.building || '').toLowerCase(), church = CHURCHY.has(b);
  let h = NaN;
  if (tags.height !== undefined) h = num(tags.height);
  if (isNaN(h) && tags['building:levels'] !== undefined) {
    const lv = num(tags['building:levels']);
    if (!isNaN(lv)) h = lv * (LEVELS_TALL.has(b) ? 3.6 : 3.2); // residential default for the rest (incl. building=yes)
  }
  if (isNaN(h)) h = PRIOR[b] ?? 9;
  if (church) { // min 15 m walls; a shaped roof adds height on top of the minimum
    const shaped = !!tags['roof:shape'];
    if (h < 15) h = 15 + (shaped ? 4 : 0);
    else if (shaped && h === 15) h += 4;
  }
  return Math.min(church ? 80 : 60, Math.max(2.5, h)); // clamp 2.5–60 m (churches to 80)
}

function bkind(tags) {
  const b = (tags.building || '').toLowerCase();
  if (CHURCHY.has(b) || b === 'landmark') return 5;                       // church / landmark
  if (b === 'apartments') return 2;                                       // apartments
  if (RESIDENTIAL.has(b)) return 1;                                       // residential
  if (['office', 'retail', 'commercial', 'hotel', 'supermarket', 'bank', 'kiosk', 'government', 'public', 'civic', 'hospital', 'school', 'university'].includes(b)) return 3; // office / retail
  if (['industrial', 'warehouse', 'factory', 'hangar', 'silo', 'storage_tank', 'service'].includes(b)) return 4; // industrial
  if (['garage', 'garages', 'carport', 'shed', 'hut', 'roof'].includes(b)) return 6; // garage / shed
  if (b === 'yes' || b === '') return 0;                                  // unknown
  return 7;                                                               // other
}
const roofCode = (t) => (t === 'gabled' ? 1 : t === 'hipped' ? 2 : 0);    // 0 flat

const buildingRec = (tags) => { // base can never sit above the roof top
  const h10 = Math.round(buildingHeight(tags) * 10);
  return { bkind: bkind(tags), roof: roofCode(tags['roof:shape']), h10, base10: Math.min(base10Of(tags), h10) };
};

function base10Of(tags) {
  let m = NaN;
  if (tags.min_height !== undefined) m = num(tags.min_height);
  if (isNaN(m) && tags['building:min_level'] !== undefined) { const lv = num(tags['building:min_level']); if (!isNaN(lv)) m = lv * 3.2; }
  return isNaN(m) ? 0 : Math.round(Math.max(0, m) * 10);
}

// roads
const RCLS = { // highway value → class (docs/mpk-format.md)
  motorway: 0, motorway_link: 0, trunk: 1, trunk_link: 1, primary: 2, primary_link: 2,
  secondary: 3, secondary_link: 3, tertiary: 4, tertiary_link: 4,
  residential: 5, living_street: 5, unclassified: 6, service: 7, pedestrian: 8,
  footway: 9, cycleway: 9, track: 9, bridleway: 9, steps: 10, path: 10,
  corridor: 10, raceway: 7, // rare values, folded into the nearest class
}; // construction / proposed / planned are not real roads: skipped (counted)
const WDEF = { 0: 30, 1: 24, 2: 18, 3: 14, 4: 11, 5: 8, 6: 6.5, 7: 5, 8: 4, 9: 2, 10: 1.5 }; // class default width, m
const SDEF = { 0: 110, 1: 90, 2: 60, 3: 50, 4: 50, 5: 40, 6: 40 };                          // class default speed, km/h
const drivable = (cls) => cls <= 6; // service (7) and up render but do not route

// water: polyline kinds (stream→4 is beyond the doc's 0..3 table by design, renderers may skip it)
const WLINE = { river: 0, canal: 2, stream: 4 };
const waterPolyKind = (t) => {
  const w = (t.water || '').toLowerCase();
  if (w === 'river') return 0;
  if (w === 'canal') return 2;
  if (w === 'pond') return 3;
  return 1; // lake / reservoir / basin / default
};

// ---------- geometry helpers ----------

const closedRing = (g) => g.length >= 4 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
// ring points in local metres, closing duplicate dropped
const ringPts = (g) => { const pts = []; for (const p of g) { if (!p) return null; pts.push(...L(p.lat, p.lon)); } pts.length -= 2; return pts; };
const linePts = (g) => { const pts = []; for (const p of g) { if (!p) return null; pts.push(...L(p.lat, p.lon)); } return pts; };

// clip to the bbox + 2 km: `out geom` returns FULL way geometry, so long cross-boundary ways
// (rivers, motorways) carry tails far past the pack's bbox. Tiles only exist inside the bbox,
// so the pack stores exactly the clipped content; the routing graph below keeps full geometry.
const M2 = 2000;
const BXLO = (BBOX[1] - ORIGIN[1]) * Math.cos(ORIGIN[0] * Math.PI / 180) * 111320 - M2, BXHI = (BBOX[3] - ORIGIN[1]) * Math.cos(ORIGIN[0] * Math.PI / 180) * 111320 + M2;
const BZLO = -(BBOX[2] - ORIGIN[0]) * 111320 - M2, BZHI = -(BBOX[0] - ORIGIN[0]) * 111320 + M2;
const snap = (v) => Math.round(v * CM) / CM; // clip boundary points land exactly on the cm grid

// Liang–Barsky: visible parameter range [t0, t1] of segment a→b against the clip rect, or null
function segClip(ax, az, bx, bz) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const P = [-dx, ax - BXLO, dx, BXHI - ax, -dz, az - BZLO, dz, BZHI - az];
  for (let i = 0; i < 8; i += 2) {
    const p = P[i], q = P[i + 1];
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

// polyline → runs of ≥2 points inside the rect (crossings interpolated to the rect edge)
function clipLine(pts) {
  const runs = [];
  let cur = null;
  const endRun = () => { if (cur && cur.length >= 4) runs.push(cur); cur = null; };
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
    const vis = segClip(ax, az, bx, bz);
    if (!vis) { endRun(); continue; }
    const [t0, t1] = vis;
    const ex = snap(ax + (bx - ax) * t0), ez = snap(az + (bz - az) * t0);
    const lx = snap(ax + (bx - ax) * t1), lz = snap(az + (bz - az) * t1);
    if (!cur) cur = [ex, ez];
    else if (cur[cur.length - 2] !== ex || cur[cur.length - 1] !== ez) { endRun(); cur = [ex, ez]; }
    if (cur[cur.length - 2] !== lx || cur[cur.length - 1] !== lz) cur.push(lx, lz);
    if (t1 < 1) endRun();
  }
  endRun();
  return runs;
}

// Sutherland–Hodgman: ring (flat pts, not repeat-closed) → [clippedRing] | [] (identity if inside)
function clipRing(pts) {
  let inside = true;
  for (let i = 0; i < pts.length && inside; i += 2) if (pts[i] < BXLO || pts[i] > BXHI || pts[i + 1] < BZLO || pts[i + 1] > BZHI) inside = false;
  if (inside) return [pts];
  let out = pts;
  for (const edge of [
    { in: (x) => x >= BXLO, ix: (ax, az, bx, bz) => [BXLO, az + (bz - az) * (BXLO - ax) / (bx - ax)] },
    { in: (x) => x <= BXHI, ix: (ax, az, bx, bz) => [BXHI, az + (bz - az) * (BXHI - ax) / (bx - ax)] },
    { in: (x, z) => z >= BZLO, ix: (ax, az, bx, bz) => [ax + (bx - ax) * (BZLO - az) / (bz - az), BZLO] },
    { in: (x, z) => z <= BZHI, ix: (ax, az, bx, bz) => [ax + (bx - ax) * (BZHI - az) / (bz - az), BZHI] },
  ]) {
    const inp = out;
    out = [];
    const n = inp.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = inp[i * 2], az = inp[i * 2 + 1], bx = inp[((i + 1) % n) * 2], bz = inp[((i + 1) % n) * 2 + 1];
      const ain = edge.in(ax, az), bin = edge.in(bx, bz);
      if (ain) { out.push(ax, az); if (!bin) { const [x, z] = edge.ix(ax, az, bx, bz); out.push(snap(x), snap(z)); } }
      else if (bin) { const [x, z] = edge.ix(ax, az, bx, bz); out.push(snap(x), snap(z)); }
    }
    if (out.length < 6) return [];
  }
  return out.length >= 6 ? [out] : [];
}

// pack-local metres → tile-local Int32 cm, assigned by the record's first point
const tiles = new Map(); // "tx,tz" → { tx, tz, b, r, w, g }
function assign(pts, kind, rec) {
  const tx = Math.floor(pts[0] / S), tz = Math.floor(pts[1] / S), key = `${tx},${tz}`;
  let t = tiles.get(key);
  if (!t) tiles.set(key, t = { tx, tz, b: [], r: [], w: [], g: [] });
  const ox = tx * S * CM, oz = tz * S * CM, out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) out[i] = Math.round(pts[i] * CM) - (i % 2 ? oz : ox);
  t[kind].push({ ...rec, pts: out });
  return t;
}

// ---------- load ----------
console.log('build: reading caches...');
const buildingsEls = readCache('buildings'), roadsEls = readCache('roads'), waterEls = readCache('water'), greenEls = readCache('green');
const stats = { wayBuildings: 0, wayBuildingsOpen: 0, relBuildings: 0, relOuterRings: 0, relInnerDropped: 0, relOuterOpen: 0,
  highwayWays: 0, roadRecs: 0, roadSkipped: 0, graphNodes: 0, graphEdges: 0, waterLine: 0, waterPoly: 0, waterSkipped: 0, greenRecs: 0, greenSkipped: 0 };

// ---------- buildings ----------
const emittedWayIds = new Set();
for (const el of buildingsEls) {
  if (el.type !== 'way' || !el.tags?.building || el.tags.building === 'no' || !el.geometry) continue;
  const g = el.geometry;
  if (!closedRing(g)) { stats.wayBuildingsOpen++; continue; } // multipolygon member: arrives via its relation
  stats.wayBuildings++;
  emittedWayIds.add(el.id);
  const pts = ringPts(g);
  if (!pts || pts.length < 6) continue;
  for (const ring of clipRing(pts)) assign(ring, 'b', buildingRec(el.tags));
}
stats.relBuildings = buildingsEls.filter((e) => e.type === 'relation').length;
// building multipolygon relations: v1 = outer rings only, inner rings (holes) dropped
for (const el of buildingsEls) {
  if (el.type !== 'relation' || !el.tags?.building || !el.members) continue;
  for (const m of el.members) {
    if (m.type !== 'way' || !m.geometry) continue;
    if (m.role === 'inner') { stats.relInnerDropped++; continue; }
    if (m.role !== 'outer') continue;
    if (!closedRing(m.geometry)) { stats.relOuterOpen++; continue; } // rings split across ways: not merged in v1
    if (emittedWayIds.has(m.ref)) continue;                        // already emitted as a standalone building
    stats.relOuterRings++;
    const pts = ringPts(m.geometry);
    if (!pts || pts.length < 6) continue;
    for (const ring of clipRing(pts)) assign(ring, 'b', buildingRec(el.tags));
  }
}

// ---------- roads (also collect drivable geometry for the graph) ----------
const drivableWays = []; // { nodeIds, pts (local m), cls, flags, name, lanes, speed }
for (const el of roadsEls) {
  if (el.type !== 'way' || !el.tags?.highway || !el.geometry) continue;
  stats.highwayWays++;
  const cls = RCLS[el.tags.highway];
  if (cls === undefined) { stats.roadSkipped++; continue; }
  const pts = linePts(el.geometry);
  if (!pts || pts.length < 4) { stats.roadSkipped++; continue; }
  const t = el.tags;
  const oneway = t.oneway === 'yes' || t.oneway === '1' ? 1 : t.oneway === '-1' ? -1 : 0;
  let nodeIds = el.nodes && el.nodes.length === el.geometry.length ? el.nodes : null; // graph needs 1:1 node↔pt
  if (oneway === -1) { // reverse so polyline + node order follow the legal travel direction
    for (let i = 0, j = pts.length - 2; i < j; i += 2, j -= 2) { [pts[i], pts[j]] = [pts[j], pts[i]]; [pts[i + 1], pts[j + 1]] = [pts[j + 1], pts[i + 1]]; }
    if (nodeIds) nodeIds = [...nodeIds].reverse();
  }
  const lanes = isNaN(num(t.lanes)) ? (cls < 4 ? 2 : 1) : Math.round(num(t.lanes));
  const width = !isNaN(num(t.width)) ? num(t.width) : !isNaN(num(t.lanes)) ? num(t.lanes) * 3.5 + 2 : WDEF[cls];
  const speed = isNaN(num(t.maxspeed)) ? SDEF[cls] : num(t.maxspeed);
  const rec = { cls, flags: oneway === -1 ? 1 : oneway, name: t.name || undefined, lanes, w10: Math.round(width * 10) };
  const runs = clipLine(pts); // split at the bbox+2km edge; the graph below keeps the full way
  for (const run of runs) assign(run, 'r', rec);
  stats.roadRecs += runs.length;
  if (drivable(cls)) drivableWays.push({ nodeIds, pts, cls, flags: rec.flags, name: t.name || undefined, lanes, speed });
}

// ---------- graph ----------
// junctions: OSM node ids shared by ≥2 drivable ways, plus every drivable way's endpoints
const nodeUse = new Map(); // nodeId → number of drivable ways touching it
for (const w of drivableWays) if (w.nodeIds) for (const id of new Set(w.nodeIds)) nodeUse.set(id, (nodeUse.get(id) || 0) + 1);
const isJunction = (id, i, len) => i === 0 || i === len - 1 || (nodeUse.get(id) || 0) >= 2;

const nodeIdx = new Map(), nodes = []; // nodeId → graph index; nodes: [x, z] in pack-local cm
const nodeXY = new Map();              // nodeId → [x, z] local metres (first occurrence)
for (const w of drivableWays) if (w.nodeIds) for (let i = 0; i < w.nodeIds.length; i++) { const id = w.nodeIds[i]; if (!nodeXY.has(id)) nodeXY.set(id, [w.pts[i * 2], w.pts[i * 2 + 1]]); }

const edges = [];
for (const w of drivableWays) {
  if (!w.nodeIds) continue;
  const ids = w.nodeIds, n = ids.length;
  const jn = []; // indices of junction points along this way, in order
  for (let i = 0; i < n; i++) if (isJunction(ids[i], i, n)) jn.push(i);
  for (let k = 0; k + 1 < jn.length; k++) {
    const i1 = jn[k], i2 = jn[k + 1], a = ids[i1], b = ids[i2];
    if (a === b) continue;
    let len = 0;
    for (let i = i1; i < i2; i++) { const dx = w.pts[i * 2 + 2] - w.pts[i * 2], dz = w.pts[i * 2 + 3] - w.pts[i * 2 + 1]; len += Math.hypot(dx, dz); }
    if (len < 0.5) continue; // degenerate sliver
    let [na, nb] = [a, b];
    if (!w.flags && a > b) [na, nb] = [b, a]; // undirected edges are stored a < b
    for (const id of [na, nb]) if (!nodeIdx.has(id)) { nodeIdx.set(id, nodes.length); const [x, z] = nodeXY.get(id); nodes.push([Math.round(x * CM), Math.round(z * CM)]); }
    edges.push({ a: nodeIdx.get(na), b: nodeIdx.get(nb), cls: w.cls, flags: w.flags, name: w.name, lanes: w.lanes, speed: Math.round(w.speed), len: Math.max(1, Math.round(len)) });
  }
}
stats.graphNodes = nodes.length;
stats.graphEdges = edges.length;

// ---------- water ----------
for (const el of waterEls) {
  const t = el.tags || {};
  if (el.type === 'way' && el.geometry) {
    const g = el.geometry;
    if (t.natural === 'water' || t.waterway === 'riverbank') {
      if (!closedRing(g)) { stats.waterSkipped++; continue; }
      const pts = ringPts(g);
      if (!pts || pts.length < 6) { stats.waterSkipped++; continue; }
      const rings = clipRing(pts);
      for (const ring of rings) assign(ring, 'w', { kind: t.waterway === 'riverbank' ? 0 : waterPolyKind(t) });
      stats.waterPoly += rings.length;
    } else if (WLINE[t.waterway] !== undefined) {
      const pts = linePts(g);
      if (!pts || pts.length < 4) { stats.waterSkipped++; continue; }
      const runs = clipLine(pts);
      for (const run of runs) assign(run, 'w', { kind: WLINE[t.waterway] });
      stats.waterLine += runs.length;
    } else stats.waterSkipped++; // ditch / drain / other waterways: skipped in v1
  } else if (el.type === 'relation' && el.members) { // water multipolygons: outer rings only (v1)
    for (const m of el.members) {
      if (m.type !== 'way' || m.role !== 'outer' || !m.geometry) continue;
      if (!closedRing(m.geometry)) { stats.relOuterOpen++; continue; }
      const pts = ringPts(m.geometry);
      if (!pts || pts.length < 6) continue;
      for (const ring of clipRing(pts)) assign(ring, 'w', { kind: waterPolyKind(t) });
      stats.waterPoly++;
    }
  }
}

// ---------- green ----------
for (const el of greenEls) {
  if (el.type !== 'way' || !el.geometry) continue;
  const t = el.tags || {};
  if (!closedRing(el.geometry)) { stats.greenSkipped++; continue; }
  const pts = ringPts(el.geometry);
  if (!pts || pts.length < 6) { stats.greenSkipped++; continue; }
  const kind = t.leisure === 'park' ? 0 : t.landuse === 'forest' ? 1 : (t.landuse === 'grass' || t.landuse === 'meadow') ? 2 : 3; // 0 park, 1 forest, 2 grass, 3 other
  const rings = clipRing(pts);
  for (const ring of rings) assign(ring, 'g', { kind });
  stats.greenRecs += rings.length;
}

// ---------- poses: 6 real Grodno viewpoints (local metres via geoToLocal) ----------
const [nemX, nemZ] = L(53.6790, 23.8170);   // over the Neman near the Soviet bridge
const [casX, casZ] = L(53.6760, 23.8220);   // the Old Castle
const [sovX, sovZ] = L(53.6810, 23.8260);   // Sovetskaya street
const [kalX, kalZ] = L(53.6690, 23.8300);   // Kalozha church area
const [cenX, cenZ] = L(53.6780, 23.8290);   // city centre (aerial)
const [staX, staZ] = L(53.6650, 23.8340);   // railway station
const [kalC_X, kalC_Z] = L(53.6698, 23.8307); // Kalozha church itself
const [staB_X, staB_Z] = L(53.6659, 23.8342); // station building
const poses = [
  [nemX, 12, nemZ, casX, 10, casZ],        // riverbank → the Old Castle across the Neman
  [casX, 14, casZ, nemX, 8, nemZ],         // the Old Castle → back over the river
  [sovX, 9, sovZ, cenX, 6, cenZ],          // Sovetskaya street → down towards the centre
  [kalX, 13, kalZ, kalC_X, 10, kalC_Z],    // Kalozha area → the church
  [cenX, 300, cenZ, cenX, 0, cenZ],        // aerial over the centre
  [staX, 10, staZ, staB_X, 8, staB_Z],     // the railway station
];

// ---------- emit ----------
const B = new MPKBuilder({ id: ID, name: NAME, origin: ORIGIN, tileSize: S, bbox: BBOX, poses, fly: null, terrain: null });
const tileList = [...tiles.values()].sort((a, b) => a.tx - b.tx || a.tz - b.tz);
for (const t of tileList) {
  const layers = [];
  if (t.b.length) layers.push({ kind: 1, recs: t.b });
  if (t.r.length) layers.push({ kind: 2, recs: t.r });
  if (t.w.length) layers.push({ kind: 3, recs: t.w });
  if (t.g.length) layers.push({ kind: 4, recs: t.g });
  if (layers.length) B.tile(t.tx, t.tz, [layers]);
}
B.graph(nodes, edges);
const buf = B.finish();
mkdirSync(path.join(root, 'packs'), { recursive: true });
writeFileSync(path.join(root, 'packs/grodno.mpk'), buf);

// ---------- stats ----------
const buildings = tileList.reduce((s, t) => s + t.b.length, 0), roads = tileList.reduce((s, t) => s + t.r.length, 0),
  water = tileList.reduce((s, t) => s + t.w.length, 0), green = tileList.reduce((s, t) => s + t.g.length, 0);
stats.buildings = buildings;
const dist = tileList.map((t) => ({ tile: `${t.tx},${t.tz}`, b: t.b.length, r: t.r.length, w: t.w.length, g: t.g.length }));
const perTile = dist.map((d) => d.b + d.r + d.w + d.g);
stats.tiles = dist;
stats.tileCount = dist.length;
stats.fileSize = buf.length;
writeFileSync(path.join(here, 'cache', 'grodno-stats.json'), JSON.stringify(stats, null, 1));

console.log(`build: buildings ${buildings} (closed ways ${stats.wayBuildings}, open ways skipped ${stats.wayBuildingsOpen}; relations ${stats.relBuildings}: outer rings +${stats.relOuterRings}, inner dropped ${stats.relInnerDropped}, open outer skipped ${stats.relOuterOpen})`);
console.log(`build: roads ${roads} of ${stats.highwayWays} highway ways (skipped ${stats.roadSkipped} unmapped/degenerate)`);
console.log(`build: water ${water} (lines ${stats.waterLine}, polygons ${stats.waterPoly}, skipped ${stats.waterSkipped}), green ${green} (skipped open ${stats.greenSkipped})`);
console.log(`build: graph ${nodes.length} nodes, ${edges.length} edges (drivable classes 0..6; service renders, not routed)`);
console.log(`build: ${dist.length} tiles, recs/tile min ${Math.min(...perTile)} avg ${Math.round(perTile.reduce((a, b) => a + b, 0) / perTile.length)} max ${Math.max(...perTile)}`);
const top = [...dist].sort((a, b) => (b.b + b.r + b.w + b.g) - (a.b + a.r + a.w + a.g)).slice(0, 10);
console.log('build: busiest tiles: ' + top.map((d) => `${d.tile}(b${d.b}/r${d.r}/w${d.w}/g${d.g})`).join(' '));
console.log(`build: packs/grodno.mpk ${(buf.length / 1024 / 1024).toFixed(2)} MB, ${B.h.strings.length} strings, poses ${poses.length}`);

// landmark sanity: the Old Castle ~[53.676,23.822] must sit within ~±100 m of where the poses put it
const [cx, cz] = L(53.676, 23.822);
let castleNear = 0;
for (const t of tileList) for (const r of t.b) {
  const x = (r.pts[0] + t.tx * S * CM) / CM, z = (r.pts[1] + t.tz * S * CM) / CM;
  if (Math.hypot(x - cx, z - cz) < 100) castleNear++;
}
console.log(`build: landmark check — Old Castle at local (${cx.toFixed(0)}, ${cz.toFixed(0)}) m, ${castleNear} buildings within 100 m`);
