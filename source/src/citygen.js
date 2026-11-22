// citygen: buildings with LODs and road centre lines, merged per tile (world.js calls cityTile).
// Instance tint is per mesh, so a tile's buildings split into a few wall meshes by colour bucket,
// each with three LODs: plain prism beyond BLOD1 m, floor bands + window strips to BLOD0 m, and a
// facade (bay frames, door, cornice, parapet) up close. Roofs are separate meshes with their own
// tint (grey / red-brown): flat ear-clip top far, gable / hip caps near — caps switch with the facade, since
// capped walls stop at the eaves. Window panes are M.WINDOW quads carrying per-pane uv (ea / eb) and
// a per-pane random (ec) from which the shader builds the room behind the glass (night lights those).
// Everything seeds off h2(tile, building): identical output on every run.

const BLOD0 = 260, BLOD1 = 650;     // facade and strips switch distances (metres)
const BPITCH = 4.6, BPITCH_M = 12;  // window pitch: near facade, mid strips
const rgb = (r, g, b, a = 1) => (round(clamp(a, 0, 1) * 255) << 24 | round(clamp(b, 0, 1) * 255) << 16 | round(clamp(g, 0, 1) * 255) << 8 | round(clamp(r, 0, 1) * 255)) >>> 0;
// wall tint per building kind (the shader mixes 55% of it into plaster); the entries are the shade jitter
const WPAL = [
  rgb(.97, .95, .9), rgb(.9, .88, .83), rgb(.99, .96, .89), // 0 unknown: warm whites
  rgb(1, .9, .74), rgb(.96, .88, .78), rgb(.99, .9, .64),   // 1 residential: cream, white, pale yellow
  rgb(.7, .73, .8), rgb(.6, .63, .71),                      // 2 apartments: cooler greys
  rgb(.55, .61, .72),                                       // 3 office / retail: blue-grey
  rgb(.67, .67, .69), rgb(.63, .42, .34),                   // 4 industrial: concrete; brick-red when 1-storey
  rgb(.97, .93, .86),                                       // 5 church: limestone
  rgb(.8, .77, .7), rgb(.72, .7, .65),                      // 6 garage / shed: dull grey, tan
  rgb(.94, .91, .85),                                       // 7 other
];
const WRANGE = [[0, 3], [3, 6], [6, 8], [8, 9], [9, 11], [11, 12], [12, 14], [14, 15]]; // WPAL span per kind
const RPAL = [rgb(.42, .42, .45), rgb(.52, .5, .5), rgb(.55, .3, .23), rgb(.48, .37, .28)]; // grey dark / grey / red tile / brown

// straight wall frame: u runs along the wall, v up, w out; outward normal on the right of u
const fWall = (x0, z0, x1, z1) => {
  const L = hypot(x1 - x0, z1 - z0); if (L < 1e-6) return null;
  const tx = (x1 - x0) / L, tz = (z1 - z0) / L;
  return { L, tx, tz, nx: tz, nz: -tx, x0, z0, y0: 0 };
};
const fp = (F, u, v, w) => [F.x0 + F.tx * u + F.nx * w, v, F.z0 + F.tz * u + F.nz * w];
// wall quad (u0..u1 along, v0..v1 up, offset w out); ao < 0 shades the ground-level foot
const wquad = (mb, F, u0, u1, v0, v1, w, ao) => {
  const A = (v) => (ao < 0 ? 0.7 + 0.3 * sstep(0, 1.5, v - F.y0) : ao);
  const { x0, z0, tx, tz, nx, nz } = F;
  mb.ea = 0; mb.eb = 0;
  mb.quad(
    mb.v(x0 + tx * u0 + nx * w, v0, z0 + tz * u0 + nz * w, nx, 0, nz, A(v0)),
    mb.v(x0 + tx * u1 + nx * w, v0, z0 + tz * u1 + nz * w, nx, 0, nz, A(v0)),
    mb.v(x0 + tx * u1 + nx * w, v1, z0 + tz * u1 + nz * w, nx, 0, nz, A(v1)),
    mb.v(x0 + tx * u0 + nx * w, v1, z0 + tz * u0 + nz * w, nx, 0, nz, A(v1)));
};
// horizontal quad between two wall offsets at height y; down: normal below
const lid = (mb, F, u0, u1, w0, w1, y, ao, down) => {
  const { x0, z0, tx, tz, nx, nz } = F, n = down ? -1 : 1;
  mb.quad(
    mb.v(x0 + tx * u0 + nx * w1, y, z0 + tz * u0 + nz * w1, 0, n, 0, ao),
    mb.v(x0 + tx * u1 + nx * w1, y, z0 + tz * u1 + nz * w1, 0, n, 0, ao),
    mb.v(x0 + tx * u1 + nx * w0, y, z0 + tz * u1 + nz * w0, 0, n, 0, ao),
    mb.v(x0 + tx * u0 + nx * w0, y, z0 + tz * u0 + nz * w0, 0, n, 0, ao));
};
// one M.WINDOW pane: uv 0-1 across it (ea / eb), per-pane random (ec); ec 0 = plain dark glazing
const pane = (mb, F, u0, u1, v0, v1, w, ec) => {
  const { x0, z0, tx, tz, nx, nz } = F, du = 255 / (u1 - u0), dv = 255 / (v1 - v0);
  mb.mat = M.WINDOW; mb.ec = ec;
  const P = (u, v) => { mb.ea = round((u - u0) * du); mb.eb = round((v - v0) * dv); return mb.v(x0 + tx * u + nx * w, v, z0 + tz * u + nz * w, nx, 0, nz, 0.88); };
  mb.quad(P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1));
  mb.ea = mb.eb = mb.ec = 0;
};
// window bay: dark stone frame plate just off the wall, glass a hair in front of it
const bay = (mb, F, u0, u1, v0, v1, ec) => {
  mb.mat = M.ROCK; wquad(mb, F, u0 - 0.1, u1 + 0.1, v0 - 0.08, v1 + 0.1, 0.02, 0.92);
  pane(mb, F, u0, u1, v0, v1, 0.045, ec);
};
// window panes of one wall for storey si, evenly spread at pitch; cb(u0, u1, v0, v1, pi) per pane
const panes = (F, si, base, ground, upper, pitch, cb) => {
  const y0 = si ? base + ground + (si - 1) * upper : base, y1 = y0 + (si ? upper : ground);
  const sill = y0 + (si ? 0.8 : 1), head = min(y1 - 0.55, sill + (si ? 1.5 : 2));
  if (head - sill < 0.6) return;
  const cnt = max(1, round((F.L - 1.8) / pitch)), pw = min(1.5, max(0.5, (F.L - 1.8) / cnt * 0.5)), gap = (F.L - cnt * pw) / (cnt + 1);
  for (let i = 0; i < cnt; i++) { const u0 = gap + i * (pw + gap); cb(u0, u0 + pw, sill, head, i); }
};
const ecOf = (iT, iB, fi, si, pi) => 1 + (h2(iT * 8 + 3, iB * 61 + fi * 17 + si * 5 + pi) * 254 | 0);
// flat roof triangulated by ear clipping at y (concave footprints poke through walls with a fan);
// holes: courtyard rings ([x,z,...] metres) carved out of the top. earclip returns pool-local
// triangle indices — rebased onto the mesh with b0 (each call appends its vertices). Earclip
// trouble, or holes that kill the triangulation: plain roof, no holes, rather than no roof.
const roofTri = (mb, X, Z, n, y, holes) => {
  const pts = new Array(n * 2);
  for (let i = 0; i < n; i++) { pts[i * 2] = X[i]; pts[i * 2 + 1] = Z[i]; }
  let c;
  try { c = earclip(pts, holes || []); if (!c.tris.length && holes && holes.length) c = earclip(pts); }
  catch { c = earclip(pts); }
  const b0 = mb.nv;
  for (let i = 0; i < c.xs.length; i++) mb.v(c.xs[i], y, c.zs[i], 0, 1, 0);
  for (let i = 0; i < c.tris.length; i += 3) mb.tri(b0 + c.tris[i], b0 + c.tris[i + 1], b0 + c.tris[i + 2]);
};
// broken centre-line paint: 1.5 m marks every 4.5 m, one thin quad each (tile-local pts in cm)
const cityDashes = (mb, pts, ox, oz) => {
  mb.mat = M.PLASTER;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = ox + pts[i] / 100, z0 = oz + pts[i + 1] / 100, x1 = ox + pts[i + 2] / 100, z1 = oz + pts[i + 3] / 100;
    const ex = x1 - x0, ez = z1 - z0, L = hypot(ex, ez); if (L < 8) continue;
    const ux = ex / L, uz = ez / L, nx = uz * 0.14, nz = -ux * 0.14;
    for (let t = 2.25; t + 1.5 <= L - 2.25; t += 4.5) {
      const ax = x0 + ux * t, az = z0 + uz * t, bx = x0 + ux * (t + 1.5), bz = z0 + uz * (t + 1.5);
      mb.quad(mb.v(ax - nx, 0.1, az - nz, 0, 1, 0), mb.v(ax + nx, 0.1, az + nz, 0, 1, 0), mb.v(bx + nx, 0.1, bz + nz, 0, 1, 0), mb.v(bx - nx, 0.1, bz - nz, 0, 1, 0));
    }
  }
};

// one building: emit far / mid / near walls into its tint bucket, roof far / near into its roof bucket.
// holes: this building's kind-6 courtyard rings (docs/mpk-format.md, matched by osmId) or null —
// they are carved out of the roof and walled base→top in every LOD.
// ox / oz: mesh origin (tile-local); cx / cz: the tile's world centre, for the collision box only
function cityBuilding(iT, iB, r, ox, oz, cx, cz, wallB, roofB, bboxes, holes) {
  const n = r.pts.length / 2; if (n < 2) return;
  let X = new Float64Array(n), Z = new Float64Array(n), A = 0;
  for (let i = 0; i < n; i++) { X[i] = ox + r.pts[i * 2] / 100; Z[i] = oz + r.pts[i * 2 + 1] / 100; }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += X[i] * Z[j] - X[j] * Z[i]; }
  if (A < 0) { // orient CCW, so wall frames carry the outward normal on their right
    const Xt = new Float64Array(n), Zt = new Float64Array(n);
    for (let i = 0; i < n; i++) { Xt[i] = X[n - 1 - i]; Zt[i] = Z[n - 1 - i]; }
    X = Xt; Z = Zt; A = -A;
  }
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < n; i++) { x0 = min(x0, X[i]); x1 = max(x1, X[i]); z0 = min(z0, Z[i]); z1 = max(z1, Z[i]); }
  const base = r.base10 / 10, top = base + r.h10 / 10;
  if (top - base < 0.1 || x1 - x0 < 0.1 || z1 - z0 < 0.1) return; // degenerate slivers (as before, no box)
  bboxes.push(x0 + cx, z0 + cz, x1 + cx, z1 + cz, top);
  const area = A / 2, h = top - base;
  // courtyard holes matched by osmId (kind 6): metres, oriented CW so wall frames face into the
  // void. Lightwells (< ~20 m²) and holes whose centroid leaves this outer ring (multi-outer
  // relations share the relation id) are ignored.
  const H = [];
  if (holes) for (const hr of holes) {
    const m = hr.pts.length >> 1; if (m < 3) continue;
    let hx = new Float64Array(m), hz = new Float64Array(m), a = 0, sx = 0, sz = 0;
    for (let i = 0; i < m; i++) { hx[i] = ox + hr.pts[i * 2] / 100; hz[i] = oz + hr.pts[i * 2 + 1] / 100; }
    for (let i = 0; i < m; i++) { // shoelace + area centroid, after the fill (hz[i+1] must exist)
      const j = (i + 1) % m; const cr = hx[i] * hz[j] - hx[j] * hz[i]; a += cr; sx += (hx[i] + hx[j]) * cr; sz += (hz[i] + hz[j]) * cr;
    }
    if (abs(a) < 40) continue; // raw shoelace sum is 2×area: < 20 m² is a lightwell, not a courtyard
    let inside = false;        // area centroid inside THIS outer ring? (ray cast)
    const px = sx / (3 * a), pz = sz / (3 * a);
    for (let i = 0, j = n - 1; i < n; j = i++) if ((Z[i] > pz) !== (Z[j] > pz) && px < (X[j] - X[i]) * (pz - Z[i]) / (Z[j] - Z[i]) + X[i]) inside = !inside;
    if (!inside) continue;
    if (a > 0) { const tx = new Float64Array(m), tz = new Float64Array(m); for (let i = 0; i < m; i++) { tx[i] = hx[m - 1 - i]; tz[i] = hz[m - 1 - i]; } hx = tx; hz = tz; }
    H.push({ X: hx, Z: hz, n: m });
  }
  const storeys = max(1, round(h / 3.2)), ground = storeys > 1 ? min(4, h * 0.55) : h, upper = storeys > 1 ? (h - ground) / (storeys - 1) : 1;
  let roof = r.roof === 1 || r.roof === 2 ? r.roof : 0, rise = 0;
  // caps only on small CONVEX plain footprints: big/industrial roofs are flat in reality, a gabled
  // cap over a holey complex would bridge the courtyards, and one over a notched ring spans the
  // notch — slope planes up to 50 m long in the Grodno pack (the "giant roof" artifact)
  if (roof && (area > 4000 || H.length)) roof = 0;
  // ridge direction: the longest wall edge (the bbox long side lied for rotated footprints — a 45°
  // house got its ridge across the walls). rx / rz: ridge unit vector; pd: ridge perpendicular;
  // pc: the ridge line's perpendicular offset; amin / amax: the ring's extent along the ridge;
  // halfP: the widest point's distance from the ridge line (drives the rise)
  let rx = 1, rz = 0, pc = 0, amin = 0, amax = 0, halfP = 0;
  if (roof) {
    let cpos = 0, cneg = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n, k = (i + 2) % n;
      const cr = (X[j] - X[i]) * (Z[k] - Z[i]) - (Z[j] - Z[i]) * (X[k] - X[i]);
      if (cr > 1e-9) cpos++; else if (cr < -1e-9) cneg++; }
    if (cpos && cneg) roof = 0;
  }
  if (roof) {
    let bl = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n, ex = X[j] - X[i], ez = Z[j] - Z[i], el = ex * ex + ez * ez;
      if (el > bl) { bl = el; const il = 1 / max(sqrt(el), 1e-9); rx = ex * il; rz = ez * il; } }
    const pdx = -rz, pdz = rx;
    let sq = 0;
    amin = 1e9; amax = -1e9;
    for (let i = 0; i < n; i++) { const a = X[i] * rx + Z[i] * rz, q = X[i] * pdx + Z[i] * pdz;
      sq += q; amin = min(amin, a); amax = max(amax, a); }
    pc = sq / n; // vertex-mean perpendicular offset: every wall is then within halfP of the ridge
    for (let i = 0; i < n; i++) halfP = max(halfP, abs(X[i] * pdx + Z[i] * pdz - pc));
    rise = max(0.15, min(clamp((roof === 1 ? 0.58 : 0.5) * halfP, 0.5, 3.4), h - 2.2));
    if (rise < 0.15) roof = 0;
  }
  const eaves = roof ? top - rise : top;
  // walls near stop at the eaves, so their storey rhythm shrinks with it
  const hW = eaves - base, storeysN = roof ? max(1, round(hW / 3.2)) : storeys;
  const groundN = storeysN > 1 ? min(4, hW * 0.55) : hW, upperN = storeysN > 1 ? (hW - groundN) / (storeysN - 1) : 1;
  // tints: shade jitter per building; industrial turns brick-red only when 1-storey
  const rj = h2(iT * 4 + 1, iB * 2 + 3), rj2 = h2(iT * 4 + 2, iB * 2 + 5);
  const wr = WRANGE[r.bkind] || WRANGE[0];
  let wi = wr[0] + min(wr[1] - wr[0] - 1, floor(rj * (wr[1] - wr[0])));
  if (r.bkind === 4 && h >= 5.5) wi = 9;
  const house = r.bkind !== 3 && r.bkind !== 4 && r.bkind !== 6;
  const wt = WPAL[wi], rt = RPAL[house ? (rj2 < .42 ? 2 : rj2 < .58 ? 3 : rj2 < .8 ? 1 : 0) : (rj2 < .55 ? 1 : rj2 < .78 ? 0 : rj2 < .9 ? 3 : 2)];
  const wb = wallB(wt), rb = roofB(rt);
  const F = [];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n, f = fWall(X[i], Z[i], X[j], Z[j]); if (f) { f.y0 = base; F.push(f); } }
  // courtyard wall frames (hole rings CW → normals face into the void); pane seeds continue after
  // the outer frames' index space, so existing buildings' windows are untouched
  const HF = [];
  for (const h of H) for (let i = 0; i < h.n; i++) { const j = (i + 1) % h.n, f = fWall(h.X[i], h.Z[i], h.X[j], h.Z[j]); if (f) { f.y0 = base; HF.push(f); } }
  // hole rings for the roof earclip (any winding — earclip forces holes CW against the outer)
  const HR = H.map((h) => { const p = new Array(h.n * 2); for (let i = 0; i < h.n; i++) { p[i * 2] = h.X[i]; p[i * 2 + 1] = h.Z[i]; } return p; });
  // windows: none on garages or 1-storey sheds; bays only on mid-size non-industrial footprints
  const winOK = storeys >= 2 && r.bkind !== 6;
  const bays = winOK && r.bkind !== 4 && area >= 45 && area <= 1100;
  // the vertex buffer is one slab (nV * 20 B vs the 256 MB WebGPU cap), so the dressed facade is
  // rationed: bands, bays and parapet faces ride the two longest walls, ends stay plain
  const F2 = [...F].sort((p, q) => q.L - p.L).slice(0, 2);
  const doorF = F2[0];
  const pitchN = BPITCH, pitchM = BPITCH_M;

  // far: plain prism walls (outer + courtyards); ear-clip roof top with the holes
  wb.f.mat = M.PLASTER;
  for (const f of F) wquad(wb.f, f, 0, f.L, base, top, 0, -1);
  for (const f of HF) wquad(wb.f, f, 0, f.L, base, top, 0, -1);
  rb.f.mat = M.ROCK;
  roofTri(rb.f, X, Z, n, top, HR);

  // mid: walls + floor bands (long walls) + window strips
  const m = wb.m; m.mat = M.PLASTER;
  for (const f of F) wquad(m, f, 0, f.L, base, top, 0, -1);
  for (const f of HF) wquad(m, f, 0, f.L, base, top, 0, -1);
  for (const f of F2) for (let k = 1; k < storeys; k++) { const y = base + ground + (k - 1) * upper; wquad(m, f, 0, f.L, y - 0.09, y + 0.09, 0.03, 0.8); }
  if (winOK) {
    for (let fi = 0; fi < F.length; fi++) for (let si = 0; si < storeys; si++)
      panes(F[fi], si, base, ground, upper, pitchM, (u0, u1, v0, v1, pi) => pane(m, F[fi], u0, u1, v0, v1, 0.015, ecOf(iT, iB, fi, si, pi)));
    for (let k = 0; k < HF.length; k++) for (let si = 0; si < storeys; si++)
      panes(HF[k], si, base, ground, upper, pitchM, (u0, u1, v0, v1, pi) => pane(m, HF[k], u0, u1, v0, v1, 0.015, ecOf(iT, iB, F.length + k, si, pi)));
  }

  // near: facade — walls, bands, bays on the long walls (strips on small ones), door, cornice, parapet
  const b = wb.n; b.mat = M.PLASTER;
  for (const f of F) wquad(b, f, 0, f.L, base, eaves, 0, -1);
  for (const f of HF) wquad(b, f, 0, f.L, base, eaves, 0, -1);
  for (const f of F2) for (let k = 1; k < storeysN; k++) { const y = base + groundN + (k - 1) * upperN; wquad(b, f, 0, f.L, y - 0.09, y + 0.09, 0.03, 0.8); }
  const HF2 = [...HF].sort((p, q) => q.L - p.L).slice(0, 2); // courtyard bands ride the 2 longest hole walls
  for (const f of HF2) for (let k = 1; k < storeysN; k++) { const y = base + groundN + (k - 1) * upperN; wquad(b, f, 0, f.L, y - 0.09, y + 0.09, 0.03, 0.8); }
  const doorSlot = (max(1, round((doorF.L - 1.8) / pitchN)) - 1) >> 1;
  if (winOK && !bays && area < 45) for (let fi = 0; fi < F.length; fi++) for (let si = 0; si < storeysN; si++)
    panes(F[fi], si, base, groundN, upperN, pitchN, (u0, u1, v0, v1, pi) => pane(b, F[fi], u0, u1, v0, v1, 0.015, ecOf(iT, iB, fi, si, pi)));
  else if (bays) for (const f of F2) for (let si = 0; si < storeysN; si++)
    panes(f, si, base, groundN, upperN, pitchN, (u0, u1, v0, v1, pi) => { if (f === doorF && si === 0 && pi === doorSlot) return; bay(b, f, u0, u1, v0, v1, ecOf(iT, iB, F.indexOf(f), si, pi)); });
  // door: dark stone frame, glazed slab behind (plain dark glass, no room)
  const dcx = doorF.L / 2, dw = min(1.2, doorF.L * 0.3), dh = min(2.35, groundN * 0.6);
  bay(b, doorF, dcx - dw / 2, dcx + dw / 2, base, base + dh, 0);
  // cornice band (front face) around the top, parapet cap ring above it — faces on the long walls only
  const c1 = eaves - (roof ? 0.04 : 0.06), c0 = c1 - 0.26;
  for (const f of F) wquad(b, f, 0, f.L, c0, c1, 0.12, 0.95);
  if (!roof) {
    for (const f of F) lid(b, f, -0.06, f.L + 0.06, 0, 0.06, top + 0.34, 1);
    for (const f of F2) wquad(b, f, 0, f.L, c1, top + 0.34, 0.06, 0.95);
  }
  // gable ends rise from the eaves to the ridge on the wall mesh
  const along = (x, z) => x * rx + z * rz, ridge = (a) => [rx * a - rz * pc, top, rz * a + rx * pc];
  if (roof === 1) for (const f of F) {
    if (abs(f.tx * rx + f.tz * rz) > 0.82) continue;
    const p0 = fp(f, 0, eaves, 0), p1 = fp(f, f.L, eaves, 0);
    const ap = ridge(clamp(along((p0[0] + p1[0]) / 2, (p0[2] + p1[2]) / 2), amin, amax));
    b.mat = M.PLASTER;
    b.tri(b.v(p0[0], p0[1], p0[2], f.nx, 0, f.nz, 1), b.v(p1[0], p1[1], p1[2], f.nx, 0, f.nz, 1), b.v(ap[0], ap[1], ap[2], f.nx, 0, f.nz, 1));
  }

  // roof near: caps over the footprint for gable / hip, ear-clip top for flat
  if (roof) {
    rb.n.mat = M.ROCK;
    const pdx = -rz, pdz = rx;
    for (const f of F) {
      const par = abs(f.tx * rx + f.tz * rz) > 0.82;
      if (!par && roof === 1) continue; // gable ends are wall triangles, done above
      const p0 = fp(f, 0, eaves, 0), p1 = fp(f, f.L, eaves, 0);
      const run = abs((p0[0] + p1[0]) / 2 * pdx + (p0[2] + p1[2]) / 2 * pdz - pc);
      if (run < 0.05) continue;
      const nl = hypot(f.nx * rise, run, f.nz * rise), N = [f.nx * rise / nl, run / nl, f.nz * rise / nl];
      const V = (p) => rb.n.v(p[0], p[1], p[2], N[0], N[1], N[2], 1);
      if (par) {
        const r0 = ridge(clamp(along(p0[0], p0[2]), amin, amax)), r1 = ridge(clamp(along(p1[0], p1[2]), amin, amax));
        rb.n.quad(V(p0), V(p1), V(r1), V(r0));
      } else {
        const ap = ridge(clamp(along((p0[0] + p1[0]) / 2, (p0[2] + p1[2]) / 2), amin, amax));
        rb.n.tri(V(p0), V(p1), V(ap));
      }
    }
  } else { rb.n.mat = M.ROCK; roofTri(rb.n, X, Z, n, top, HR); }
}

// a tile's buildings and road paint: buckets keyed by packed tint (deterministic mesh grouping).
// holes: Map osmId → [kind-6 recs] (world.js groups the tile's hole layers); only relation-provenance
// buildings (src bit 4) can receive them — osmIds of ways and relations are different id spaces.
// Meshes come out tile-centre-local: the caller places each instance at (ox + S/2, oz + S/2), so the
// cull pass gets a ~360 m bounding radius per tile and the LOD distances mean what they say.
function cityTile(iT, lods, ox, oz, S, bboxes, holes) {
  const h = S / 2, cx = ox + h, cz = oz + h;
  const walls = new Map(), roofs = new Map();
  let dash = null;
  const wallB = (t) => { let b = walls.get(t); if (!b) walls.set(t, b = { t, n: new MB(1 << 11), m: new MB(1 << 11), f: new MB(1 << 10) }); return b; };
  const roofB = (t) => { let b = roofs.get(t); if (!b) roofs.set(t, b = { t, n: new MB(1 << 10), f: new MB(1 << 9) }); return b; };
  for (const L of lods) {
    if (L.kind === 1) for (let iB = 0; iB < L.recs.length; iB++) {
      const r = L.recs[iB];
      cityBuilding(iT, iB, r, -h, -h, cx, cz, wallB, roofB, bboxes, holes && (r.src & 16) ? holes.get(r.osmId) : null);
    }
    else if (L.kind === 2) for (const r of L.recs) if (r.cls <= 3) { if (!dash) dash = new MB(1 << 12); cityDashes(dash, r.pts, -h, -h); }
  }
  return { walls, roofs, dash };
}
