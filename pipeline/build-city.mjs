// builds packs/grodno.mpk from the Overpass caches produced by pipeline/fetch.mjs.
// Projection: geoToLocal() metres about the pack origin, quantized to Int32 centimetres, tile-local.
//
// v1 simplifications (kept deliberately, logged at build time):
//  - building multipolygon relations: outer rings become buildings, inner rings become kind-6
//    hole records (v2.1 courtyards); rings split across ways are still not merged;
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
  let h = NaN, src = 0; // src: 0 prior/default, 1 levels-based, 2 height-tagged (provenance, see docs)
  if (tags.height !== undefined) { h = num(tags.height); if (!isNaN(h)) src = 2; }
  if (isNaN(h) && tags['building:levels'] !== undefined) {
    const lv = num(tags['building:levels']);
    if (!isNaN(lv)) { h = lv * (LEVELS_TALL.has(b) ? 3.6 : 3.2); src = 1; } // residential default for the rest (incl. building=yes)
  }
  if (isNaN(h)) h = PRIOR[b] ?? 9;
  if (church) { // min 15 m walls; a shaped roof adds height on top of the minimum
    const shaped = !!tags['roof:shape'];
    if (h < 15) h = 15 + (shaped ? 4 : 0);
    else if (shaped && h === 15) h += 4;
  }
  return { h: Math.min(church ? 80 : 60, Math.max(2.5, h)), src }; // clamp 2.5–60 m (churches to 80)
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

// src bits: 0-1 height source (0 prior/default, 1 levels, 2 height tag), 2 roof:shape tagged, 3 colour tagged,
// 4 from a relation (osmId is a relation id), 5-7 reserved — the provenance the report/analysis tools read
const buildingRec = (tags, id = 0, rel = false) => { // base can never sit above the roof top
  const H = buildingHeight(tags), h10 = Math.round(H.h * 10);
  const src = (H.src & 3) | (tags['roof:shape'] ? 4 : 0) | ((tags['building:colour'] ?? tags.colour) !== undefined ? 8 : 0) | (rel ? 16 : 0);
  return { bkind: bkind(tags), roof: roofCode(tags['roof:shape']), h10, base10: Math.min(base10Of(tags), h10), osmId: id | 0, src };
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

// water: polyline (centreline) kinds — 8/9/10 live above the polygon table 0..3 so the renderer
// can tell a river centreline from a riverbank polygon (docs/mpk-format.md)
const WLINE = { river: 8, stream: 9, canal: 10 };
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

// the format stores CLOSED polygon rings (first == last, 1 cm tolerance): append the first point
// when the Sutherland–Hodgman clip above left the ring open (it drops the closing duplicate)
const closeRing = (pts) => {
  const dx = pts[0] - pts[pts.length - 2], dz = pts[1] - pts[pts.length - 1];
  return dx * dx + dz * dz > 1e-4 ? [...pts, pts[0], pts[1]] : pts;
};

// pack-local metres → tile-local Int32 cm, assigned by the record's first point
const tiles = new Map(); // "tx,tz" → { tx, tz, b, r, w, g, h }
function assignTo(t, pts, kind, rec) {
  const ox = t.tx * S * CM, oz = t.tz * S * CM, out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) out[i] = Math.round(pts[i] * CM) - (i % 2 ? oz : ox);
  t[kind].push({ ...rec, pts: out });
  return t;
}
function assign(pts, kind, rec) {
  const tx = Math.floor(pts[0] / S), tz = Math.floor(pts[1] / S), key = `${tx},${tz}`;
  let t = tiles.get(key);
  if (!t) tiles.set(key, t = { tx, tz, b: [], r: [], w: [], g: [], h: [] });
  return assignTo(t, pts, kind, rec);
}

// hole guards (courtyards, docs/mpk-format.md kind 6): signed shoelace area (m²), area centroid,
// point-in-ring, proper segment crossing — a self-intersecting hole would break ear clipping
const ringArea2 = (pts) => { let a = 0; for (let i = 0; i < pts.length; i += 2) { const j = (i + 2) % pts.length; a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1]; } return a / 2; };
const ringCentroid = (pts, a) => {
  let cx = 0, cz = 0;
  for (let i = 0; i < pts.length; i += 2) { const j = (i + 2) % pts.length, cr = pts[i] * pts[j + 1] - pts[j] * pts[i + 1]; cx += (pts[i] + pts[j]) * cr; cz += (pts[i + 1] + pts[j + 1]) * cr; }
  return [cx / (6 * a), cz / (6 * a)];
};
const pip = (x, z, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const zi = pts[i + 1], zj = pts[j + 1];
    if ((zi > z) !== (zj > z) && x < (pts[j] - pts[i]) * (z - zi) / (zj - zi) + pts[i]) inside = !inside;
  }
  return inside;
};
const segCross = (ax, az, bx, bz, cx, cz, dx, dz) => { // proper crossing of ab and cd (touching is fine)
  const o = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (rx - px) * (qz - pz);
  const d1 = o(cx, cz, dx, dz, ax, az), d2 = o(cx, cz, dx, dz, bx, bz), d3 = o(ax, az, bx, bz, cx, cz), d4 = o(ax, az, bx, bz, dx, dz);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
};
const selfIntersects = (pts) => {
  const n = pts.length >> 1;
  const P = (i) => [pts[i * 2], pts[i * 2 + 1]];
  for (let a = 0; a < n; a++) for (let b = a + 2; b < n; b++) {
    if (a === 0 && b === n - 1) continue; // adjacent through the closing edge
    const [ax, az] = P(a), [bx, bz] = P((a + 1) % n), [cx, cz] = P(b), [dx, dz] = P((b + 1) % n);
    if (segCross(ax, az, bx, bz, cx, cz, dx, dz)) return true;
  }
  return false;
};

// ---------- load ----------
console.log('build: reading caches...');
const buildingsEls = readCache('buildings'), roadsEls = readCache('roads'), waterEls = readCache('water'), greenEls = readCache('green');
const stats = { wayBuildings: 0, wayBuildingsOpen: 0, relBuildings: 0, relOuterRings: 0, relInner: 0, relInnerEmitted: 0, relInnerDropped: 0, relHoleSelfInt: 0, relOuterOpen: 0,
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
  for (const ring of clipRing(pts)) assign(ring, 'b', buildingRec(el.tags, el.id, el.type === 'relation'));
}
stats.relBuildings = buildingsEls.filter((e) => e.type === 'relation').length;
// building multipolygon relations: outer rings become buildings; inner rings become kind-6 hole
// records (v2.1 courtyards) keyed by the relation's osmId, emitted into the parent outer's tile
for (const el of buildingsEls) {
  if (el.type !== 'relation' || !el.tags?.building || !el.members) continue;
  const outers = []; // { t (tile), ring (clipped pts, open) } — hole containment + tile routing
  for (const m of el.members) {
    if (m.type !== 'way' || m.role !== 'outer' || !m.geometry) continue;
    if (!closedRing(m.geometry)) { stats.relOuterOpen++; continue; } // rings split across ways: not merged in v1
    if (emittedWayIds.has(m.ref)) continue;                        // already emitted as a standalone building
    const pts = ringPts(m.geometry);
    if (!pts || pts.length < 6) continue;
    for (const ring of clipRing(pts)) { stats.relOuterRings++; outers.push({ t: assign(ring, 'b', buildingRec(el.tags, el.id, true)), ring }); }
  }
  const holes = []; // accepted inner rings: { pts, oi } — oi indexes outers[]
  for (const m of el.members) {
    if (m.type !== 'way' || m.role !== 'inner' || !m.geometry) continue;
    stats.relInner++;
    if (!closedRing(m.geometry)) { stats.relInnerDropped++; continue; } // rings split across ways: not merged in v1
    const raw = ringPts(m.geometry);
    if (!raw || raw.length < 6) { stats.relInnerDropped++; continue; }
    for (const pts of clipRing(raw)) {
      const a = ringArea2(pts); // signed area, m²
      if (Math.abs(a) < 20) { stats.relInnerDropped++; continue; } // < ~20 m²: lightwell, not a courtyard
      const [cx, cz] = ringCentroid(pts, a);
      const oi = outers.findIndex((o) => pip(cx, cz, o.ring));    // multi-outer relations share the osmId
      if (oi < 0) { stats.relInnerDropped++; continue; }          // parent outer open/skipped or bad data
      holes.push({ pts, oi });
    }
  }
  // a self-intersecting hole would break ear clipping: drop that outer's holes, keep the rest
  const bad = new Set(holes.filter((h) => selfIntersects(h.pts)).map((h) => h.oi));
  for (const h of holes) {
    if (bad.has(h.oi)) { stats.relInnerDropped++; stats.relHoleSelfInt++; continue; }
    assignTo(outers[h.oi].t, closeRing(h.pts), 'h', { osmId: el.id });
    stats.relInnerEmitted++;
  }
}

// ---------- roads (also collect drivable geometry for the graph) ----------
const drivableWays = []; // { nodeIds, pts (local m), cls, flags, name, lanes, speed }
const ribbonLines = []; // { pts (local m), rec } — merged into continuation chains before packing
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
  ribbonLines.push({ pts, rec });
  stats.roadRecs++;
  if (drivable(cls)) drivableWays.push({ nodeIds, pts, cls, flags: rec.flags, name: t.name || undefined, lanes, speed });
}

// mappers cut one road into many ways at every junction; two ways that merely continue each other
// through a 2-way node left a wedge gap between their ribbon butt lines at every such seam. Chains
// of same-class, same-width ways continuing at < 15° glue into one polyline (the graph below still
// builds from the original per-way geometry, so junction nodes stay junctions)
const COS15 = Math.cos(15 * Math.PI / 180);
{
  const ends = new Map(); // "x,z" (dm grid) → [{ line, atStart }]
  const key = (x, z) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
  for (const l of ribbonLines) for (const atStart of [true, false]) {
    const [x, z] = atStart ? [l.pts[0], l.pts[1]] : [l.pts[l.pts.length - 2], l.pts[l.pts.length - 1]];
    const k = key(x, z);
    if (!ends.has(k)) ends.set(k, []);
    ends.get(k).push({ line: l, atStart });
  }
  const dirOf = (l, atStart) => atStart ? [l.pts[2] - l.pts[0], l.pts[3] - l.pts[1]] : [l.pts[l.pts.length - 4] - l.pts[l.pts.length - 2], l.pts[l.pts.length - 3] - l.pts[l.pts.length - 1]];
  let merged = 0;
  for (const l of ribbonLines) {
    if (l.dead) continue;
    for (let guard = 0; guard < 64; guard++) {
      const k = key(l.pts[l.pts.length - 2], l.pts[l.pts.length - 1]);
      const cand = (ends.get(k) || []).filter((e) => e.line !== l && !e.line.dead && e.atStart && e.line.rec.cls === l.rec.cls && e.line.rec.w10 === l.rec.w10 && e.line.rec.flags === l.rec.flags);
      if (cand.length !== 1) break; // a junction (3+ ends) or nothing: the node stays
      const n2 = cand[0].line;
      if (l.pts.length / 2 + n2.pts.length / 2 > 4000) break;
      const d1 = dirOf(l, false), d2 = dirOf(n2, true);
      const dot = (d1[0] * d2[0] + d1[1] * d2[1]) / (Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]) || 1);
      if (dot < COS15) break; // a real corner: the joint keeps its miters
      l.pts.push(...n2.pts); // same travel direction, the tails already touch: concatenate
      n2.dead = true;
      l.merges = (l.merges || 0) + 1 + (n2.merges || 0);
      merged++;
    }
  }
  stats.mergedRoads = merged;
  for (const l of ribbonLines) {
    if (l.dead) continue;
    const runs = clipLine(l.pts); // split at the bbox+2km edge; the graph below keeps the full way
    for (const run of runs) assign(run, 'r', l.rec);
    stats.roadRecs += runs.length;
  }
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
      for (const ring of rings) assign(closeRing(ring), 'w', { kind: t.waterway === 'riverbank' ? 0 : waterPolyKind(t) });
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
      for (const ring of clipRing(pts)) assign(closeRing(ring), 'w', { kind: waterPolyKind(t) });
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
  for (const ring of rings) assign(closeRing(ring), 'g', { kind });
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
  if (t.h.length) layers.push({ kind: 6, recs: t.h }); // building holes (docs v2.1)
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
stats.holes = tileList.reduce((s, t) => s + t.h.length, 0);
const dist = tileList.map((t) => ({ tile: `${t.tx},${t.tz}`, b: t.b.length, r: t.r.length, w: t.w.length, g: t.g.length }));
const perTile = dist.map((d) => d.b + d.r + d.w + d.g);
stats.tiles = dist;
stats.tileCount = dist.length;
stats.fileSize = buf.length;
writeFileSync(path.join(here, 'cache', 'grodno-stats.json'), JSON.stringify(stats, null, 1));

console.log(`build: buildings ${buildings} (closed ways ${stats.wayBuildings}, open ways skipped ${stats.wayBuildingsOpen}; relations ${stats.relBuildings}: outer rings +${stats.relOuterRings}, inner rings ${stats.relInner} → ${stats.relInnerEmitted} holes (dropped ${stats.relInnerDropped}${stats.relHoleSelfInt ? `, ${stats.relHoleSelfInt} self-intersecting` : ''}), open outer skipped ${stats.relOuterOpen})`);
const holeRecs = tileList.reduce((s, t) => s + t.h.length, 0), holeArea = tileList.reduce((s, t) => s + t.h.reduce((q, r) => q + Math.abs(ringArea2(r.pts)) / 1e4, 0), 0);
console.log(`build: building holes ${holeRecs} records, ${(holeArea).toFixed(0)} m² of courtyards carved out of the roofs`);
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

// ---------- pack QA: every shipped defect class is a gate here — a new city fails its build ----------
console.log(`build: roads merged ${stats.mergedRoads || 0} continuation seams into longer polylines`);
{
  const { qa } = await import('./qa.mjs');
  const rep = await qa('packs/grodno.mpk');
  console.log(`build: QA — ${rep.errors.length} errors, ${rep.warns.length} warns (joints ${rep.stats.roadJoints}, gaps ${rep.stats.roadJointGaps})`);
  for (const e of rep.errors) console.log('  QA ERROR:', e.check, e.msg);
  for (const w of rep.warns) console.log('  QA warn:', w.check, w.msg);
  if (rep.errors.length) process.exitCode = 1;
}
