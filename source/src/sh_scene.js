// shaders 2/4: instancing, GPU culling, materials (G-buffer) and shadow casters
// material ids, shared by mesh generators and shaders
const M = { MARBLE: 0, PAVE: 1, PLASTER: 2, GOLD: 3, QUAY: 4, FLOOR: 5, WINDOW: 6, BARK: 7, ALLOY: 8, TRIM: 9, TERRAIN: 10, CORE: 11, TERRACE: 12, GROUND: 13, STEP: 14, ROCK: 15, FALL: 16, SEA: 17, ASPHALT: 18, LEAF: 19 };

// per view, a compute pass frustum-tests each instance, picks its LOD and appends it to that mesh's list, drawn with one
// indirect draw per mesh
const W_INST = /*wgsl*/`
struct Inst { p: vec4f, q: vec4f, tint: u32, ty: u32, rad: f32, sy: f32 }
`;
const W_CULL = W_COMMON + W_INST + /*wgsl*/`
struct MType { slot: vec4u, d: vec4f, e: vec4f } // slots of up to four LODs; d: two switch distances, far limit, thinning start; e.x: third switch distance
struct Args { ic: u32, n: atomic<u32>, fi: u32, bv: u32, first: u32 }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> inst: array<Inst>;
@group(0) @binding(2) var<storage, read> types: array<MType>;
@group(0) @binding(3) var<storage, read_write> args: array<Args>;
@group(0) @binding(4) var<storage, read_write> vis: array<u32>;
const NONE = 0xffffffffu;
fn emit(slot: u32, i: u32, f: f32, inv: u32) {
  if (slot == NONE || f <= 0.) { return; }
  let k = atomicAdd(&args[slot].n, 1u);
  vis[args[slot].first + k] = i | (u32(sat(f) * 127.) << 24u) | (inv << 31u);
}
@compute @workgroup_size(64) fn reset(@builtin(global_invocation_id) id: vec3u) { if (id.x < arrayLength(&args)) { atomicStore(&args[id.x].n, 0u); } }
@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x; if (i >= arrayLength(&inst)) { return; }
  let it = inst[i]; let mt = types[it.ty]; let c = it.p.xyz;
  for (var k = 0; k < 6; k++) { if (dot(view.planes[k].xyz, c) + view.planes[k].w < -it.rad) { return; } }
  let d = max(max(distance(view.lodc.xyz, c) - it.rad * .5, 0.) * view.misc.z, view.lodb.x);
  // gone beyond the far limit; lodc.w removes the level's LOD scale here, so far forests stay on Medium/Low
  var f = sat((mt.d.z - d * view.lodc.w) / (mt.d.z * .08));
  // small things thin out with distance, each by its own threshold (+1: whole until the density drops below it)
  if (mt.d.w > 0.) { let keep = 1. - .8 * sat((d - mt.d.w) / (mt.d.w * 2.5)); let h = fract(f32(i) * .6180339 + .37); f *= sat((keep - h) * 40. + 1.); }
  if (f <= 0.) { return; }
  // LOD and the next switch distance; each instance switches +-13% off, so changes never sweep a grove as one ring
  let dl = d * (.87 + .26 * fract(f32(i) * .7548777));
  var lv = 0; var edge = mt.d.x;
  if (dl >= mt.d.x && mt.slot.y != NONE) { lv = 1; edge = mt.d.y; if (dl >= mt.d.y && mt.slot.z != NONE) { lv = 2; edge = mt.e.x; if (dl >= mt.e.x && mt.slot.w != NONE) { lv = 3; } } }
  let cur = mt.slot[lv]; var nxt = NONE; if (lv < 3) { nxt = mt.slot[lv + 1]; }
  // cross-fade over the last 22% before each switch with complementary dithers (fixed dither in shadow views)
  if (nxt != NONE && dl > edge * .78) { let t = (dl - edge * .78) / (edge * .22); emit(cur, i, min(f, 1. - t), 0u); emit(nxt, i, min(f, t), 1u); }
  else { emit(cur, i, f, 0u); }
}
`;

// vertex stage shared by all instanced geometry
const W_SCENE_VS = W_COMMON + W_INST + /*wgsl*/`
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var sRep: sampler;
@group(0) @binding(2) var sLin: sampler;
@group(0) @binding(3) var<storage, read> inst: array<Inst>;
@group(0) @binding(4) var<storage, read> vis: array<u32>;
@group(0) @binding(5) var tNoiseA: texture_2d<f32>;
@group(0) @binding(6) var tNoiseN: texture_2d<f32>;
@group(0) @binding(7) var tMap: texture_2d<f32>;
@group(0) @binding(8) var tLand: texture_2d<f32>;
struct VI { @location(0) pos: vec3f, @location(1) nrm: vec4f, @location(2) ext: vec4f, @builtin(instance_index) ii: u32 }
struct VO {
  @builtin(position) clip: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) uv: vec3f, @location(3) ao: f32,
  @location(4) tint: vec4f, @location(5) @interpolate(flat) mi: vec2u, @location(6) lp: vec3f, @location(7) @interpolate(flat) q: vec4f,
}
// sea swell: four trains from the south-west (xy wave vector, z height, w angular speed), each faded where the mesh
// (vertex) or pixel (fragment) can't resolve it. Returns height and slope.
const SEAW = array<vec4f, 4>(vec4f(.159, -.092, .2, 1.34), vec4f(.15, -.26, .12, 1.72), vec4f(.473, .082, .065, 2.17), vec4f(.157, -.77, .035, 2.77));
fn seaWave(p: vec2f, fade: vec4f) -> vec3f {
  var o = vec3f(0.); let t = view.cam.w; let calm = mix(.4, 1., ss(480., 950., length(p))); // sheltered near the city
  for (var k = 0; k < 4; k++) { let w = SEAW[k]; let ph = dot(w.xy, p) - w.w * t; let a = w.z * fade[k] * calm; o += vec3f(a * sin(ph), w.xy * (a * cos(ph))); }
  return o;
}
fn transform(v: VI) -> VO {
  let e = vis[v.ii]; let it = inst[e & 0xffffffu];
  let mat = u32(v.ext.x * 255. + .5);
  let s = vec3f(it.p.w, it.p.w * it.sy, it.p.w);
  let lp = v.pos * s;
  let q = it.q;
  var wp = it.p.xyz + qrot(q, lp);
  if (mat == 17u) {
    // the sea's rings follow the camera; each train fades where the rings get too coarse
    wp = vec3f(lp.x + view.lodc.x, 0., lp.z + view.lodc.z);
    wp.y = seaWave(wp.xz, clamp(vec4f(2.) - length(lp.xz) * ${((SEA_GROW - 1) * SEAK).toFixed(4)} * vec4f(.1765, .2857, .4615, .75), vec4f(0.), vec4f(1.))).x;
  }
  var n = qrot(q, v.nrm.xyz / s);
  if (mat == 8u) {
    // hovering craft loop around the rings; moored ones only bob
    let sd = f32(it.tint >> 24u) / 255.; let r = length(it.p.xz); let t = view.cam.w;
    if (r < 450.) { let a = t * (5. + 5. * sd) / r * (1. + .3 * sin(t * .05 + sd * 20.)) * view.misc.w; let c = cos(a); let sn = sin(a); wp = vec3f(wp.x * c - wp.z * sn, wp.y, wp.x * sn + wp.z * c); n = vec3f(n.x * c - n.z * sn, n.y, n.x * sn + n.z * c); }
    wp.y += sin(t * .7 + sd * 40.) * .22 * view.misc.w;
  }
  var o: VO;
  o.clip = view.vp * vec4f(wp, 1.); o.wp = wp; o.n = n; o.uv = v.ext.yzw; o.ao = v.nrm.w;
  o.tint = unpack4x8unorm(it.tint); o.mi = vec2u(mat, e >> 24u); o.lp = v.pos; o.q = q;
  // Low: LODs swap at mid-fade instead of dissolving; the hidden one collapses to a point here, so no fragment shader
  // needs a discard (phone GPUs only reject hidden fragments early for shaders that never discard)
  if (LV > 1) { if (((e >> 24u) & 127u) < 64u) { o.clip = vec4f(2., 2., 2., 1.); } o.mi.y = 127u; }
  return o;
}
@vertex fn vs(v: VI) -> VO { return transform(v); }
`;

// shadow casters (depth only): the vertex stage. Foliage, crystal and glass casters were Atlantis scene furniture.
const W_SHADOW = W_SCENE_VS;

// materials: fills the G-buffer
const W_GBUF =W_SCENE_VS + /*wgsl*/`
struct GO { @location(0) a: vec4f, @location(1) n: vec4f, @location(2) m: vec4f }
struct Mt { alb: vec3f, rough: f32, metal: f32, inlay: f32, nb: vec3f, trans: f32 }
// triplanar noise: seamless on any wall, detail fades with the mips
fn triW(n: vec3f) -> vec3f { var w = pow(abs(n), vec3f(6.)); return w / (w.x + w.y + w.z); }
fn tri(t: texture_2d<f32>, p: vec3f, dx: vec3f, dy: vec3f, w: vec3f, s: f32) -> vec4f {
  var c = vec4f(0.);
  if (w.x > .02) { c += w.x * textureSampleGrad(t, sRep, p.zy * s, dx.zy * s, dy.zy * s); }
  if (w.y > .02) { c += w.y * textureSampleGrad(t, sRep, p.xz * s, dx.xz * s, dy.xz * s); }
  if (w.z > .02) { c += w.z * textureSampleGrad(t, sRep, p.xy * s, dx.xy * s, dy.xy * s); }
  return c;
}
// bump from the slope texture (rg or ba) as a world-space tilt
fn triN(p: vec3f, dx: vec3f, dy: vec3f, w: vec3f, s: f32, rock: bool) -> vec3f {
  var o = vec3f(0.);
  if (w.x > .02) { let c = textureSampleGrad(tNoiseN, sRep, p.zy * s, dx.zy * s, dy.zy * s); let g = select(c.rg, c.ba, rock) - .5; o += w.x * vec3f(0., g.y, g.x); }
  if (w.y > .02) { let c = textureSampleGrad(tNoiseN, sRep, p.xz * s, dx.xz * s, dy.xz * s); let g = select(c.rg, c.ba, rock) - .5; o += w.y * vec3f(g.x, 0., g.y); }
  if (w.z > .02) { let c = textureSampleGrad(tNoiseN, sRep, p.xy * s, dx.xy * s, dy.xy * s); let g = select(c.rg, c.ba, rock) - .5; o += w.z * vec3f(g.x, g.y, 0.); }
  return o;
}
// coverage of a line (half width hw, distance d) for a pixel fw wide: thin lines fade instead of aliasing
fn line(d: f32, hw: f32, fw: f32) -> f32 { return sat((min(d + fw * .5, hw) - max(d - fw * .5, -hw)) / fw); }
const MARB = vec3f(.82, .79, .735);
var<private> gVein: f32; // how veined the last marble() sample was
fn marble(p: vec3f, dx: vec3f, dy: vec3f, w: vec3f, off: vec3f) -> vec4f { // rgb colour factor, a grain
  let A = tri(tNoiseA, p + off, dx, dy, w, .21); let B = tri(tNoiseA, p, dx, dy, w, 1.9); let C = tri(tNoiseA, p + off.zxy, dx, dy, w, .047);
  let v = A.b * .85 + .15 * ss(.5, .75, B.b); gVein = v;
  var c = vec3f(1. - .07 * (C.r - .5) - .05 * (A.r - .5) - .03 * (B.a - .5));
  c = mix(c, vec3f(.62, .65, .7), v * .4);
  c *= mix(vec3f(1.), vec3f(1.03, 1., .95), ss(.4, .65, C.r)); // warm and cool drifts
  return vec4f(c, B.a);
}
// polished paving, 2 m modules: rings and radials near the centre, a grid further out; gold inlay lines
fn pave(p: vec3f, dx: vec3f, dy: vec3f, fw: f32, n: vec3f) -> Mt {
  let cell = floor(p.xz / 2.); // 2 m flagstone grid (the Atlantis podium radials are gone)
  let g = p.xz / 2.; let f = min(fract(g), 1. - fract(g)) * 2.; let jd = min(f.x, f.y);
  let hs = h22(cell + 3.);
  let w = triW(n); let m = marble(p, dx, dy, w, vec3f(hs.x, 0., hs.y) * 40.);
  var o: Mt; o.alb = vec3f(.79, .76, .705) * m.rgb * (.93 + .14 * hs.x); o.rough = .13 + .12 * m.a + .08 * hs.y; o.metal = 0.; o.trans = 0.;
  o.nb = triN(p, dx, dy, w, 2.3, false) * .035;
  o.alb = mix(o.alb, o.alb * vec3f(.56, .6, .68), gVein * .55); // polished slabs show grey veins clearly
  let j = line(jd, .005, fw); o.alb *= 1. - .5 * j; o.rough = mix(o.rough, .7, j);
  o.inlay = 0.; // the Atlantis podium's golden radials are gone: pack paving is roads and plazas
  return o;
}
// asphalt: dark aggregate, lane-worn — drivable roads only (footways stay flagstone)
fn asphalt(p: vec3f, dx: vec3f, dy: vec3f, fw: f32, n: vec3f) -> Mt {
  let w = triW(n);
  let g = tri(tNoiseA, p, dx, dy, w, 2.1); let fine = tri(tNoiseA, p, dx, dy, w, 11.);
  var o: Mt; o.metal = 0.; o.inlay = 0.; o.trans = 0.;
  o.alb = vec3f(.105, .105, .112) * (.82 + .36 * g.r) * (.88 + .24 * fine.a);
  o.rough = .62 + .1 * g.a;
  o.nb = triN(p, dx, dy, w, .35, false) * .12;
  return o;
}
// city ground: paving where the map says, else lawn, beds and flagstone paths
fn ground(p: vec3f, dx: vec3f, dy: vec3f, fw: f32, n: vec3f) -> Mt {
  let muv = p.xz / 2048. + .5; let mp = textureSampleGrad(tMap, sLin, muv, dx.xz / 2048., dy.xz / 2048.);
  let w = vec3f(0., 1., 0.);
  let A = tri(tNoiseA, p, dx, dy, w, .45); let B = tri(tNoiseA, p, dx, dy, w, 2.7);
  let edge = (A.r - .5) * .5 + (B.a - .5) * .25;
  if (mp.r + edge * .3 > .5) { return pave(p, dx, dy, fw, n); }
  var o: Mt; o.metal = 0.; o.inlay = 0.; o.trans = 0.;
  let C = tri(tNoiseA, p, dx, dy, w, .06);
  // lawn: one broad tint plus a single grain factor — the old double product (blob × grain × grain)
  // veined like wet marble from above ("grass like water")
  o.alb = mix(vec3f(.075, .12, .04), vec3f(.13, .165, .05), ss(.3, .7, C.r)) * (.82 + .36 * B.a); o.rough = .9;
  o.nb = triN(p, dx, dy, w, 1.4, true) * .15;
  // planting beds: dark soil
  let bed = ss(.42, .58, mp.g + edge); o.alb = mix(o.alb, mix(vec3f(.15, .11, .075), vec3f(.07, .11, .04), ss(.4, .6, A.r)) * (.6 + .8 * B.a), bed);
  // paths: pale flagstones, grass in the gaps — only where the map says (the noise edge term used
  // to hallucinate flagstone ridges across open lawn: bright winding filaments, "grass like water")
  let path = ss(.3, .7, mp.b);
  if (path > 0.) {
    let cl = tri(tNoiseA, p, dx, dy, w, .9).g; let st = ss(.035, .09, cl) ; let m = marble(p, dx, dy, w, vec3f(0.));
    let stone = vec3f(.7, .66, .58) * m.rgb * (.85 + .3 * A.r);
    o.alb = mix(o.alb, mix(o.alb * .8, stone, st), path); o.rough = mix(o.rough, mix(.9, .5, st), path); o.nb = mix(o.nb, o.nb * .3, path * st);
  }
  // green zones from the pack: parks, forests and meadows get their own tint; woods additionally
  // get a canopy pattern so an aerial view reads as trees rather than one flat green sheet
  let land = textureSampleGrad(tLand, sLin, muv, dx.xz / 2048., dy.xz / 2048.);
  if (land.a < .5) { // unpainted alpha is 1 — a painted polygon stores kind + 1 (1..4)
    let cn = tri(tNoiseA, p, dx, dy, w, .09);
    let crowns = ss(.43, .6, cn.r * .7 + cn.g * .3);
    let woods = 1. - ss(.5, 1.5, abs(land.a * 255. - 2.)); // kind 1 = forest
    let green = land.rgb * mix(.9, .5 + .6 * crowns, woods) * (.84 + .32 * B.a);
    o.alb = mix(o.alb, green, .88);
    o.nb = mix(o.nb, triN(p, dx, dy, w, .6, true) * (.15 + .4 * woods), .6);
  }
  return o;
}
// land beyond the canals: pasture, fields, tracks, limestone, forest floor, river banks, beaches, sea bed.
// tv (meshTerrain): steepness, river proximity, hollow or crest.
fn terrain(p: vec3f, dx: vec3f, dy: vec3f, fw: f32, n: vec3f, tv: vec3f) -> Mt {
  var o: Mt; o.metal = 0.; o.inlay = 0.; o.trans = 0.;
  let w = triW(n); let r = length(p.xz); let th = atan2(p.z, p.x); let h = p.y; let up = vec3f(0., 1., 0.);
  // noise at five scales: R 80 m, L 20 m, M 5 m, A 1 m, B grain
  let R = tri(tNoiseA, p, dx, dy, up, .0031); let L = tri(tNoiseA, p, dx, dy, up, .011); let M = tri(tNoiseA, p, dx, dy, up, .047);
  let A = tri(tNoiseA, p, dx, dy, w, .19); let B = tri(tNoiseA, p, dx, dy, w, 1.6);
  let az = atan2(p.x, -p.z) * 57.2958; let north = ss(-52., -30., az) * (1. - ss(62., 88., az));
  let steep = tv.x * .64; let wet = tv.y; let hollow = tv.z * 2. - 1.;
  // limestone: pale, bedded (broad layers far, finer close), cracked, water-stained, ochre in places
  let st = mix(.5, sin(h * .23 + A.r * 5. + L.r * 14.) * .5 + .5, sat(1. - fw / 2.5) * .7);
  let beds = sin(h * .085 + L.r * 7. + L.g * 3.) * .5 + .5; let bed2 = ss(.35, .65, sin(h * .31 + L.r * 11. + A.r * 2.) * .5 + .5);
  let sq3 = vec3f(1., .13, 1.); let stain = tri(tNoiseA, p * sq3, dx * sq3, dy * sq3, w, .21).r;
  var rock = vec3f(.6, .585, .55) * (.72 + .08 * st + .16 * beds + .06 * bed2 + .2 * (A.b - .3)) * (.85 + .3 * B.a);
  rock = mix(rock, vec3f(.3, .27, .23), .32 * ss(.5, .72, stain + (M.r - .5) * .3) * ss(.25, .45, 1. - n.y) * ss(.35, .6, L.r + R.g * .4));
  rock = mix(rock, vec3f(.5, .4, .29), .14 * ss(.5, .8, L.g + R.r * .5));
  rock *= 1. - .35 * ss(.5, .8, A.b) * sat(1. - fw / 1.5);
  // finer bedding: ledges ~1 m apart with shade lines (and their tilt, below)
  let ledge = h * .9 + L.r * 9. + A.r * 1.2; let lk = sat(1. - fw / 2.5); rock *= 1. - .12 * ss(.55, .95, sin(ledge) * .5 + .5) * lk;
  // relief from three sizes of fractured rock (up to 14 m) and the ledges: a face's crags
  let rn = triN(p, dx, dy, w, .07, true) * 1.7 + triN(p, dx, dy, w, .33, true) * 1.6 + triN(p, dx, dy, w, 2.1, true) * .5 + vec3f(0., cos(ledge) * .4 * lk, 0.);
  // grass: lush in hollows and by the river, dry gold on crests, tussock patches, worn earth, flowers up close
  let dry = sat(.5 + (R.r - .5) * 1.8 + (L.r - .5) * .9 + (M.r - .5) * .35 - hollow * .5 - wet * .7);
  var grass = mix(vec3f(.055, .115, .03), vec3f(.21, .2, .075), dry);
  grass = mix(grass, vec3f(.04, .085, .028), ss(.38, .8, M.r + (L.g - .35) * .6 + (A.r - .5) * .4) * .4);
  grass *= (.7 + .6 * A.a) * (.72 + .56 * B.a);
  grass = mix(grass, vec3f(.21, .16, .105) * (.7 + .6 * B.a), ss(.66, .82, M.b + (A.r - .5) * .35) * (.2 + .5 * dry));
  grass = mix(grass, mix(vec3f(.72, .7, .62), vec3f(.75, .58, .12), step(.5, B.r)), ss(.15, .08, A.g) * ss(.5, .68, M.r + (L.g - .3) * .5) * sat(1. - fw / .05));
  grass = mix(grass, vec3f(.26, .25, .13), ss(240., 520., h + L.r * 200.) * .7);
  // farmland from the load-time maps (world.js): tMap r track, g wide rows, b verge, a tilled; tLand rgb crop colour,
  // a earth between rows. Rows follow the rings; far away they average out.
  let muv = p.xz / 2048. + .5; var mp = vec4f(0.); var crop = vec4f(.3, .4, .2, 0.);
  if (max(abs(muv.x - .5), abs(muv.y - .5)) < .5) { mp = textureSampleGrad(tMap, sLin, muv, dx.xz / 2048., dy.xz / 2048.); crop = textureSampleGrad(tLand, sLin, muv, dx.xz / 2048., dy.xz / 2048.); }
  let field = ss(.35, .6, mp.a + (A.r - .5) * .25) * (1. - ss(.1, .2, steep));
  let wob = L.r * 2.5 + (A.r - .5) * .35;
  let row = mix(mix(.5, ss(.3, .7, sin(r * 4.488 + wob) * .5 + .5 + (B.r - .5) * .5), sat(1. - fw / .45)), mix(.5, ss(.3, .7, sin(r * 2.244 + wob) * .5 + .5 + (B.r - .5) * .4), sat(1. - fw / .9)), mp.g);
  let earth = vec3f(.24, .175, .115) * (.72 + .56 * B.a) * (.85 + .3 * A.a);
  let plant = crop.rgb * crop.rgb * (.74 + .52 * A.a) * (.8 + .4 * B.a) * (.9 + .2 * M.r);
  o.alb = mix(grass, mix(plant, earth, crop.a * (1. - row)), field); o.rough = .88; o.nb = triN(p, dx, dy, w, 1.4, true) * .5;
  // verge: rank darker grass; track: pale trodden earth
  o.alb = mix(o.alb, grass * vec3f(.66, .78, .62), mp.b * .8);
  let track = ss(.35, .6, mp.r + (A.r - .5) * .4 + (M.r - .5) * .2);
  o.alb = mix(o.alb, mix(vec3f(.43, .37, .28), vec3f(.52, .49, .43), ss(.2, .1, B.g)) * (.72 + .5 * B.a) * (.85 + .3 * A.a), track * .9);
  // forest floor under the mountain woods
  let wood = north * ss(25., 60., h) * (1. - ss(260., 430., h + L.r * 160.)) * ss(.3, .5, L.r + A.r * .3);
  o.alb = mix(o.alb, vec3f(.035, .07, .028) * (.6 + .8 * B.a), wood * .9);
  // gravel and pebbles by and in the river
  o.alb = mix(o.alb, mix(vec3f(.5, .47, .4), vec3f(.3, .28, .25), ss(.34, .14, A.g)) * (.7 + .5 * B.a), ss(.6, .82, wet + (A.r - .5) * .35 + (M.r - .5) * .25));
  // rock where steep or above the grass line, with an edge ragged at every scale (a soft gradient reads as haze)
  let mtn = ss(60., 200., h); let edge = mix(.2, .3, mtn);
  let rq = steep + (A.r - .5) * .15 + (M.r - .5) * .2 + (L.r - .5) * .22 * mtn + (B.a - .5) * .05 - hollow * .04;
  let rk = max(ss(edge - .02, edge + .02, rq), ss(360., 600., h + L.r * 220.) * .8);
  // scree on nearly-steep slopes
  let scree = ss(edge - .09, edge - .03, rq) * (1. - rk) * ss(.4, .2, A.g) * mtn;
  o.alb = mix(o.alb, vec3f(.5, .47, .41) * (.7 + .5 * B.a), scree * .8);
  o.alb = mix(o.alb, rock, rk); o.rough = mix(o.rough, .8, rk); o.nb = mix(o.nb, rn, rk);
  // roads: the spokes continue as pale stone ways
  let a6 = (fract((th - PI * .5) / (PI / 3.) + .5) - .5) * (PI / 3.); let lat = abs(r * sin(a6));
  let road = (1. - ss(4.6, 5.4, lat + (B.a - .5) * .6)) * ss(-3., 1., h) * (1. - ss(760., 900., r)) * step(0., cos(a6));
  if (road > 0.) { let m = marble(p, dx, dy, w, vec3f(0.)); let g = p.xz / 1.6; let f = min(fract(g), 1. - fract(g)) * 1.6; o.alb = mix(o.alb, vec3f(.72, .69, .62) * m.rgb * (1. - .4 * line(min(f.x, f.y), .012, fw)), road); o.rough = mix(o.rough, .5, road); o.nb *= 1. - road * .8; }
  // shore: wet rock and sand, then the sea bed with weed
  let sand = vec3f(.6, .56, .46) * (.8 + .4 * B.a);
  let shore = 1. - ss(.3, 2.2, h + (A.r - .5) * 1.5);
  o.alb = mix(o.alb, mix(sand, rock * .8, ss(.4, .62, A.g + L.r * .6 + rk)), shore * (1. - wet));
  if (h < .3) { let dk = ss(.3, -.4, h); o.alb *= mix(1., .62, dk); o.rough = mix(o.rough, .3, dk * ss(-.5, .3, h)); o.alb = mix(o.alb, vec3f(.05, .09, .05), ss(.5, .75, L.g * .5 + A.r) * ss(-.5, -3., h) * .8); }
  return o;
}
@fragment fn fs(i: VO) -> GO {
  // all derivatives first, while control flow is uniform
  let p = i.wp; let dx = dpdx(p); let dy = dpdy(p); let fw = max(length(dx), length(dy));
  var N = normalize(i.n); let mat = i.mi.x; let w = triW(N);
  let dnx = dpdx(N); let dny = dpdy(N);
  // pane uv gradients: the window branch's curtain edge softness
  let uvx = dpdx(i.uv.xy); let uvy = dpdy(i.uv.xy);
  let px = i.clip.xy; let fb = i.mi.y; let nz = ign(px + view.jit.z * 5.588);
  if ((fb & 127u) != 127u) { let f = f32(fb & 127u) / 127.; if ((fb & 128u) != 0u) { if (nz < 1. - f) { discard; } } else if (nz >= f) { discard; } }
  var o: Mt; o.metal = 0.; o.inlay = 0.; o.trans = 0.; o.nb = vec3f(0.); o.rough = .5; o.alb = vec3f(.8);
  var ao = i.ao; var glass = 0.;
  if (mat == 0u || mat == 4u || mat == 9u) {
    // marble: honed walls in courses, smooth trim, quay walls with a waterline
    let m = marble(p, dx, dy, w, vec3f(0.));
    o.alb = MARB * m.rgb; o.rough = select(.47, .3, mat == 9u) + .12 * (m.a - .5); o.nb = triN(p, dx, dy, w, 2.3, false) * .06;
    if (mat != 9u) {
      let wall = 1. - abs(N.y); let cy = p.y / .62; let j = line(min(fract(cy), 1. - fract(cy)) * .62, .004, fw) * wall;
      let ax = select(p.x, p.z, w.x > w.z) / 1.3 + h11(floor(cy)) * 7.; let vj = line(min(fract(ax), 1. - fract(ax)) * 1.3, .004, fw) * wall * ss(.6, .9, max(w.x, w.z));
      o.alb *= (1. - .32 * max(j, vj)) * (.975 + .05 * h21(vec2f(floor(cy), floor(ax))));
    }
    if (mat == 4u) {
      let d = p.y - select(${WATER}, 0., i.uv.x > .5); let B = tri(tNoiseA, p, dx, dy, w, .8);
      let wet = 1. - ss(.02, .3 + .25 * B.r, d);
      let moss = ss(.5, .0, d - B.r * .5) * ss(.35, .6, B.r * .7 + B.a * .4 + .12 * ss(.3, -.3, d));
      o.alb = mix(o.alb, o.alb * vec3f(.5, .56, .5), wet); o.rough = mix(o.rough, .2, wet);
      o.alb = mix(o.alb, vec3f(.07, .1, .03) * (.6 + .8 * B.a), moss * .85); o.rough = mix(o.rough, .7, moss);
      o.alb = mix(o.alb, vec3f(.2, .25, .19), ss(-.2, -2.5, d) * .6);
    }
  } else if (mat == 18u) {
    o = asphalt(p, dx, dy, fw, N);
  } else if (mat == 1u || mat == 14u) {
    o = pave(p, dx, dy, fw, N);
    if (mat == 14u) {
      o.inlay = 0.;
      // a flight drawn as a ramp (uv.y): a faint line per step, fading below a pixel
      if (i.uv.y > .5) { let sy = p.y / .18; o.alb *= 1. - .3 * line(min(fract(sy), 1. - fract(sy)) * .18, .014, fw * .6); o.rough = max(o.rough, .34); }
    }
  }
  else if (mat == 13u) { o = ground(p, dx, dy, fw, N); }
  else if (mat == 10u) { o = terrain(p, dx, dy, fw, N, i.uv); }
  else if (mat == 2u) {
    let A = tri(tNoiseA, p, dx, dy, w, .33); let B = tri(tNoiseA, p, dx, dy, w, 3.1);
    o.alb = mix(vec3f(.79, .76, .7), i.tint.rgb, .55) * (1. - .08 * (A.r - .5) - .05 * (B.a - .5)); o.rough = .78; o.nb = triN(p, dx, dy, w, 3.3, false) * .2;
  } else if (mat == 3u) { o.alb = vec3f(.86, .6, .22); o.metal = 1.; o.rough = .33; o.inlay = .14; } // gold
  else if (mat == 5u) {
    let g = p.xz / 1.5; let f = min(fract(g), 1. - fract(g)) * 1.5; let A = tri(tNoiseA, p, dx, dy, w, .31); let B = tri(tNoiseA, p, dx, dy, w, 1.7);
    // canal floor slabs barely differ, or their grid shows through the water
    o.alb = mix(vec3f(.66, .64, .57), vec3f(.74, .7, .58), A.r) * (.82 + .3 * B.a) * (1. - .16 * line(min(f.x, f.y), .015, fw)) * (.98 + .04 * h21(floor(g))); o.rough = .6; o.nb = triN(p, dx, dy, w, 1.1, true) * .35;
  } else if (mat == 6u) {
    // window glass: the dim warm room behind; the lighting pass adds the Fresnel reflection (last G-buffer channel = glass)
    glass = 1.; o.rough = .05; o.alb = vec3f(.05, .046, .042);
    if (i.uv.z > .002) {
      // a wall window's pane has its own uv (0-1) and random (uv.z); r salts the room by day and the night glow alike
      let u = i.uv.xy; let fu = max(abs(uvx.x), abs(uvy.x));
      let r = h21(vec2f(floor(i.uv.z * 255. + .5), dot(i.q, vec4f(13.1, 71.7, 31.3, 47.9)))); // rounded: interpolation leaves the number slightly off
      if (view.night.x > .5) {
        // night: no ray-marched room — ~55% of panes glow warm (2900-4000 K), some of those dim, the rest stay dark;
        // the pane colour lands in the G-buffer and the lighting pass scales it up (only emissives bloom at night)
        var e = mix(vec3f(1., .62, .36), vec3f(1., .84, .66), fract(r * 13.7)) * step(.45, fract(r * 7.31)) * mix(1., .16, step(.78, fract(r * 5.7))) * (.6 + .4 * fract(r * 31.1));
        e *= 1. - .5 * ss(.25, 1., u.y); // dimmer towards the ceiling
        if (r > .42) { // the day code's curtain: dark cloth over the glow
          let cu = select(u.x, 1. - u.x, fract(r * 3.7) > .5); let cw = (.2 + .22 * fract(r * 13.3)) * (1. + .05 * sin(u.y * 7. + r * 20.) * u.y);
          e = mix(e, vec3f(.012, .011, .01), 1. - ss(cw - fu, cw + fu, cu));
        }
        o.alb = e;
      } else {
        // the room is a box behind the pane, ray-traced in the pane's frame, so it shifts with the camera
        let T = normalize(cross(vec3f(0., 1., 0.), N) + vec3f(1e-5, 0., 0.));
        let sg = sign(dot(dx, T) * uvx.x + dot(dy, T) * uvy.x + 1e-12); // which way u runs along the wall
        let E = normalize(p - view.cam.xyz); let ez = max(-dot(E, N), .2);
        let sl = vec2f(dot(E, T) * sg * 1.4, E.y * 1.1) / ez; // ray drift across the room, in pane sizes (the room is deeper than wide)
        var t = 1.; var side = 0; // 0 back wall, 1 side wall, 2 floor or ceiling
        if (abs(sl.x) > 1e-4) { let ts = (select(-.6, 1.6, sl.x > 0.) - u.x) / sl.x; if (ts < t) { t = ts; side = 1; } }
        if (abs(sl.y) > 1e-4) { let tf = (select(-.45, 1.25, sl.y > 0.) - u.y) / sl.y; if (tf < t) { t = tf; side = 2; } }
        let q = u + sl * t;
        // warm grey walls, darker up and in the corners; a paler floor
        var room = vec3f(.17, .15, .125) * (.55 + .45 * sat(1. - q.y)) * mix(.8, 1.15, r);
        if (side == 1) { room *= .7; } else if (side == 2) { room = select(vec3f(.065, .06, .054), vec3f(.27, .22, .16) * (1.3 - t), sl.y < 0.); }
        else {
          // back wall: a doorway or a picture, by the window's number
          let dq = abs(q - vec2f(.2 + .6 * fract(r * 5.3), .1)); if (r < .45 && dq.x < .16 && dq.y < .62) { room *= .35; }
          let pq = abs(q - vec2f(.25 + .5 * fract(r * 9.1), .62)); if (r > .6 && pq.x < .17 && pq.y < .13) { room = vec3f(.2, .16, .1) * (.6 + .8 * fract(r * 31.)); }
        }
        o.alb = room * (1. - .45 * t);
        // some windows have a half-drawn curtain (folds fade before aliasing)
        if (r > .42) {
          let cu = select(u.x, 1. - u.x, fract(r * 3.7) > .5); let cw = (.2 + .22 * fract(r * 13.3)) * (1. + .05 * sin(u.y * 7. + r * 20.) * u.y);
          let fold = .5 + .5 * sin(cu / cw * 16. + r * 40.);
          let cur = vec3f(.5, .46, .4) * mix(vec3f(1.), vec3f(.85, .92, 1.05), fract(r * 23.)) * mix(.8, .62 + .36 * fold, sat(1. - fu / (cw * .12)));
          o.alb = mix(o.alb, cur, 1. - ss(cw - fu, cw + fu, cu));
        }
      }
    }
  } else if (mat == 7u) {
    let s = vec3f(1., .22, 1.); let A = tri(tNoiseA, i.lp * s, dx * s, dy * s, w, 1.3); let B = tri(tNoiseA, p, dx, dy, w, 4.);
    o.alb = mix(vec3f(.13, .1, .075), vec3f(.3, .27, .22), A.r * A.r * 1.6) * (.6 + .7 * B.a) * (.5 + .5 * i.tint.g); o.rough = .9; o.nb = triN(i.lp * s, dx * s, dy * s, w, 2.2, true) * 1.4;
  } else if (mat == 8u) { o.alb = vec3f(.84, .86, .88); o.metal = 1.; o.rough = .2; }
  else if (mat == 11u) { o.alb = i.tint.rgb * i.tint.rgb * .22; o.rough = .9; o.trans = .2; } // cypress core, planter soil
  else if (mat == 12u) {
    let g = p.xz / .9; let f = min(fract(g), 1. - fract(g)) * .9; let m = marble(p, dx, dy, w, vec3f(0.));
    o.alb = vec3f(.76, .72, .64) * m.rgb * (.95 + .1 * h21(floor(g))) * (1. - .4 * line(min(f.x, f.y), .006, fw)); o.rough = .42; o.nb = triN(p, dx, dy, w, 2.3, false) * .05;
  } else if (mat == 15u) {
    let A = tri(tNoiseA, p, dx, dy, w, .5); let B = tri(tNoiseA, p, dx, dy, w, 2.4);
    o.alb = vec3f(.6, .57, .51) * i.tint.rgb * (.7 + .5 * A.r) * (.8 + .4 * B.a); o.rough = .8; o.nb = triN(p, dx, dy, w, .6, true) * 1.5 + triN(p, dx, dy, w, 3., true) * .5;
    let d = p.y; let wet = 1. - ss(.0, .5, d); o.alb = mix(o.alb, o.alb * .5, wet); o.rough = mix(o.rough, .25, wet); o.alb = mix(o.alb, vec3f(.06, .09, .04), ss(.5, .7, A.g + B.a * .4) * ss(.9, -.2, d));
  } else if (mat == 19u) {
    // foliage: two noise scales (leaf clusters + finer grain), tint carries the species colour
    let A = tri(tNoiseA, p, dx, dy, w, .55); let B = tri(tNoiseA, p, dx, dy, w, 3.4);
    o.alb = mix(vec3f(.045, .13, .035), vec3f(.14, .29, .075), A.r * .7 + B.a * .3) * i.tint.rgb * (.8 + .4 * A.a);
    o.rough = .88; o.nb = triN(p, dx, dy, w, 1.1, true) * .7;
  } else {
    // mountain stream and fall (uv.x across, uv.y bed steepness): white and streaked when falling, glassy with threads
    // when running; ragged edges move with the flow
    let ac = abs(i.uv.x * 2. - 1.); let stp = i.uv.y; let tm = view.cam.w;
    let A = tri(tNoiseA, vec3f(p.x, p.y * .2 + tm * (.35 + .9 * stp), p.z), dx, dy, w, .4); let B = tri(tNoiseA, vec3f(p.x, p.y * .45 + tm * (.8 + 1.6 * stp), p.z), dx, dy, w, 1.5);
    if (ac + (A.r - .5) * .55 + (B.a - .5) * .3 > .84) { discard; }
    let foam = ss(.3, .62, stp * 1.2 + (A.r - .5) * .9 + (B.r - .5) * .4 + ss(.45, .9, ac) * .35);
    o.alb = mix(vec3f(.1, .2, .19), mix(vec3f(.4, .5, .53), vec3f(.88, .9, .92), ss(.3, .72, A.r * .7 + B.a * .6)), foam); o.rough = mix(.1, .6, foam);
  }
  N = normalize(N - o.nb);
  // specular AA: in-pixel curvature widens the highlight instead of sparkling
  let kr = min(2. * (dot(dnx, dnx) + dot(dny, dny)) * .25, .18);
  let rough = sqrt(sat(sq(o.rough) + kr));
  var g: GO; g.a = vec4f(sqrt(sat3(o.alb)), o.inlay); g.n = vec4f(N, max(rough, .045)); g.m = vec4f(ao, o.metal, o.trans, glass);
  return g;
}
`;
// Low (phones): tile GPUs only skip hidden fragments for shaders without discard. All discards are stripped (LODs
// hard-switch in the vertex stage; streams lose their ragged edges).
const W_GBUF_LOW = W_GBUF.replace(/discard;/g, '');
