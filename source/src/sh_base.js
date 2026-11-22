// shaders 1/4: shared code, textures and tables baked at load, sky and atmosphere
// atmosphere (CPU side: the sun's colour at the ground)
// Rayleigh + Mie + ozone, same constants as the sky shader; metres
const ATM = { RG: 6360e3, RT: 6440e3, BR: [5.802e-6, 13.558e-6, 33.1e-6], BM: 0.85e-5, BME: 0.95e-5, BO: [0.65e-6, 1.881e-6, 0.085e-6], HR: 8000, HM: 1200 };
const E0 = 16; // sun illuminance above the atmosphere, scene units
// ground-to-sun transmittance, and the multiple-scattering factor PSI (Hillaire 2020) at the ground
// (called once per profile: the day sun, and the night moon)
const atmo = (sun) => {
  const { RG, RT, BR, BM, BME, BO, HR, HM } = ATM, o = [0, RG + 30, 0];
  const dens = (p) => { const h = hypot(p[0], p[1], p[2]) - RG; return [exp(-h / HR), exp(-h / HM), max(0, 1 - abs(h - 25e3) / 15e3)]; };
  const far = (p, d, R) => { const b = p[0] * d[0] + p[1] * d[1] + p[2] * d[2], c = p[0] * p[0] + p[1] * p[1] + p[2] * p[2] - R * R, q = b * b - c; return q < 0 ? -1 : -b + sqrt(q); };
  const near = (p, d, R) => { const b = p[0] * d[0] + p[1] * d[1] + p[2] * d[2], c = p[0] * p[0] + p[1] * p[1] + p[2] * p[2] - R * R, q = b * b - c; return q < 0 || b > 0 ? -1 : -b - sqrt(q); };
  const trans = (p, d, n) => {
    const tm = far(p, d, RT), dt = tm / n, od = [0, 0, 0];
    for (let i = 0; i < n; i++) { const t = (i + 0.5) * dt, q = dens([p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t]); od[0] += q[0] * dt; od[1] += q[1] * dt; od[2] += q[2] * dt; }
    return [0, 1, 2].map((c) => exp(-(BR[c] * od[0] + BME * od[1] + BO[c] * od[2])));
  };
  const sd = [hypot(sun[0], sun[2]), sun[1], 0], Ts = trans(o, sd, 64);
  const L2 = [0, 0, 0], fms = [0, 0, 0], NA = 8, NB = 16, NS = 24;
  for (let a = 0; a < NA; a++) for (let b = 0; b < NB; b++) {
    const ct = 1 - 2 * (a + 0.5) / NA, st = sqrt(1 - ct * ct), ph = (b + 0.5) / NB * TAU, d = [st * cos(ph), ct, st * sin(ph)];
    let tm = near(o, d, RG); if (tm < 0) tm = far(o, d, RT);
    const od = [0, 0, 0], dt = tm / NS;
    for (let i = 0; i < NS; i++) {
      const t = (i + 0.5) * dt, p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], q = dens(p), tsun = trans(p, sd, 10);
      od[0] += q[0] * dt; od[1] += q[1] * dt; od[2] += q[2] * dt;
      for (let c = 0; c < 3; c++) { const T = exp(-(BR[c] * od[0] + BME * od[1] + BO[c] * od[2])), ss = BR[c] * q[0] + BM * q[1]; L2[c] += T * ss * tsun[c] * dt / (NA * NB * 4 * PI) * 4 * PI / (4 * PI); fms[c] += T * ss * dt / (NA * NB); }
    }
  }
  return { Ts, PSI: [0, 1, 2].map((c) => L2[c] / (1 - min(fms[c], 0.9))) };
};

// shared WGSL
const W_COMMON = /*wgsl*/`
const PI = 3.14159265;
const LV = ${LV}; // quality.js
fn sat(x: f32) -> f32 { return clamp(x, 0., 1.); }
fn sat3(x: vec3f) -> vec3f { return clamp(x, vec3f(0.), vec3f(1.)); }
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = sat((x - a) / (b - a)); return t * t * (3. - 2. * t); }
fn sq(x: f32) -> f32 { return x * x; }
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(.2126, .7152, .0722)); }
// interleaved gradient noise: dither for stochastic effects, averaged out by TAA
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(.06711056, .00583715)))); }
fn h11(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
fn h21(p: vec2f) -> f32 { var q = fract(vec3f(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn h22(p: vec2f) -> vec2f { var q = fract(vec3f(p.xyx) * vec3f(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
fn qmul(a: vec4f, b: vec4f) -> vec4f { return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz)); } // b first, then a
// one camera's view (main, shadow)
struct View {
  vp: mat4x4f, ivp: mat4x4f, pvp: mat4x4f,
  sm: array<mat4x4f, 4>, // camera cascade, then the three baked maps
  cam: vec4f, // position, time
  res: vec4f,   // width, height and their inverses
  jit: vec4f, // sub-pixel jitter (ndc), frame number, w spare (was the mirror clip height)
  sun: vec4f,   // direction towards the sun
  sunc: vec4f, // sun illuminance at the ground, exposure
  right: vec4f, // right, tan(half fov x)
  up: vec4f, // up, tan(half fov y)
  fwd: vec4f, // forward, near plane
  planes: array<vec4f, 6>,
  pulse: vec4f, // retired Atlantis pulse; nothing reads it, the field stays so the layout is unchanged
  misc: vec4f, // 1 = drop TAA history, view kind (0 main, 1 shadow), lod scale, wind on/off
  lodc: vec4f, // LOD reference point; w: 1 / the level's distance scale
  lodb: vec4f, // x: minimum LOD distance (baked maps on Medium/Low: never the finest)
  night: vec4f, // x: 1 = the night profile (moon sun, stars, emissive windows, cool grade); yzw spare
}
`;
// full-screen triangle
const W_FS = /*wgsl*/`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0., 1.); }
`;

// tiling detail textures (baked once)
const W_NOISE =W_COMMON + W_FS + /*wgsl*/`
fn hp(p: vec2f, per: f32) -> f32 { return h21(p - per * floor(p / per) + per * 3.7); }
fn tn(p: vec2f, per: f32) -> f32 {
  let i = floor(p); let f = p - i; let u = f * f * f * (f * (f * 6. - 15.) + 10.);
  return mix(mix(hp(i, per), hp(i + vec2f(1., 0.), per), u.x), mix(hp(i + vec2f(0., 1.), per), hp(i + vec2f(1., 1.), per), u.x), u.y);
}
fn tf(uv: vec2f, per: f32, n: i32) -> f32 { var a = .5; var s = 0.; var pr = per; for (var i = 0; i < n; i++) { s += a * tn(uv * pr + f32(i) * 7.3, pr); pr *= 2.; a *= .5; } return s / (1. - 2. * a); }
fn tw(uv: vec2f, per: f32) -> vec2f {
  let p = uv * per; let i = floor(p); var d = vec2f(9.);
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let c = i + vec2f(f32(x), f32(y)); let w = c - per * floor(c / per);
    let q = c + h22(w + 17.) - p; let l = dot(q, q);
    if (l < d.x) { d.y = d.x; d.x = l; } else if (l < d.y) { d.y = l; }
  } }
  return sqrt(d);
}
// marble veins: thin dark ridges of warped noise
fn vein(uv: vec2f) -> f32 {
  let w = vec2f(tf(uv + .31, 4., 4), tf(uv + .77, 4., 4)) - .5;
  let a = 1. - abs(2. * tf(uv + w * .22, 3., 5) - 1.); let b = 1. - abs(2. * tf(uv + w * .3 + .5, 6., 4) - 1.);
  return sat(pow(a, 14.) + .5 * pow(b, 22.));
}
fn hFine(uv: vec2f) -> f32 { return tf(uv, 24., 5) + .35 * tf(uv, 128., 2); }
fn hRock(uv: vec2f) -> f32 { let r = 1. - abs(2. * tf(uv, 5., 6) - 1.); let c = tw(uv, 9.); return r * r * .7 + (c.y - c.x) * .5 + .25 * tf(uv, 40., 3); }
// A: r soft cloudy noise, g cells, b veins, a fine grain
@fragment fn fsA(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / ${NOISEPX}.;
  return vec4f(tf(uv, 4., 7), tw(uv, 16.).x, vein(uv), tf(uv, 96., 3));
}
// N: slopes of two height fields: rg fine grain and pores, ba fractured rock
@fragment fn fsN(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / ${NOISEPX}.; let e = 1. / 1024.;
  let a = hFine(uv); let b = hRock(uv);
  let da = vec2f(hFine(uv + vec2f(e, 0.)) - a, hFine(uv + vec2f(0., e)) - a) * 60.;
  let db = vec2f(hRock(uv + vec2f(e, 0.)) - b, hRock(uv + vec2f(0., e)) - b) * 40.;
  return vec4f(da * .5 + .5, db * .5 + .5);
}
`;

// sky table (baked once per profile: the sun never moves within a profile)
// clear-sky radiance per unit sun illuminance: u = azimuth from the sun, v = elevation (denser near the horizon).
// Single scattering marched, multiple from PSI. k + tint scale the march (1 day; night: the moon's dim blue, see
// main.js — the display path multiplies by E0 as always, so the table carries the profile's absolute level).
const W_SKYLUT = (a, sun, k = 1, tint = [1, 1, 1]) => W_COMMON + W_FS + /*wgsl*/`
const RG = ${ATM.RG}.; const RT = ${ATM.RT}.; const BR = vec3f(${ATM.BR}); const BM = ${ATM.BM}; const BME = ${ATM.BME}; const BO = vec3f(${ATM.BO});
const PSI = vec3f(${a.PSI}); const SE = ${asin(sun[1])};
fn dens(p: vec3f) -> vec3f { let h = length(p) - RG; return vec3f(exp(-h / ${ATM.HR}.), exp(-h / ${ATM.HM}.), max(0., 1. - abs(h - 25000.) / 15000.)); }
fn ext(d: vec3f) -> vec3f { return BR * d.x + vec3f(BME * d.y) + BO * d.z; }
fn hit(p: vec3f, d: vec3f, r: f32, nearSide: bool) -> f32 { let b = dot(p, d); let q = b * b - dot(p, p) + r * r; if (q < 0.) { return -1.; } if (nearSide) { if (b > 0.) { return -1.; } return -b - sqrt(q); } return -b + sqrt(q); }
fn odSun(p: vec3f, sd: vec3f) -> vec3f { let tm = hit(p, sd, RT, false); let dt = tm / 10.; var od = vec3f(0.); for (var i = 0; i < 10; i++) { od += dens(p + sd * (f32(i) + .5) * dt) * dt; } return od; }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / vec2f(256., 128.);
  let az = (uv.x - .5) * 2. * PI; let v = uv.y * 2. - 1.; let el = sign(v) * v * v * PI * .5;
  let rd = vec3f(cos(el) * cos(az), sin(el), cos(el) * sin(az)); let sd = vec3f(cos(SE), sin(SE), 0.);
  let ro = vec3f(0., RG + 30., 0.);
  var tm = hit(ro, rd, RG, true); if (tm < 0.) { tm = hit(ro, rd, RT, false); }
  let mu = dot(rd, sd); let pr = 3. / (16. * PI) * (1. + mu * mu);
  let g = .8; let pm = 3. / (8. * PI) * (1. - g * g) * (1. + mu * mu) / ((2. + g * g) * pow(1. + g * g - 2. * g * mu, 1.5));
  var od = vec3f(0.); var L = vec3f(0.); const N = 48.;
  for (var i = 0.; i < N; i += 1.) {
    let t0 = tm * sq(i / N); let t1 = tm * sq((i + 1.) / N); let dt = t1 - t0; let p = ro + rd * (t0 + t1) * .5; let d = dens(p);
    od += d * dt * .5; let ts = exp(-ext(odSun(p, sd)));
    L += exp(-ext(od)) * ((BR * d.x * pr + BM * d.y * pm) * ts + (BR * d.x + BM * d.y) * PSI) * dt;
    od += d * dt * .5;
  }
  return vec4f(L * vec3f(${tint}) * ${k.toFixed(8)}, 1.);
}
`;
// the sky as seen: table, sun disc, drifting clouds. Needs tSky, tNoiseA, sRep, view.
const W_SKY = /*wgsl*/`
const E0 = ${E0}.;
fn skyLut(d: vec3f) -> vec3f {
  let az = atan2(d.z, d.x) - atan2(view.sun.z, view.sun.x); let el = asin(clamp(d.y, -1., 1.));
  let uv = vec2f(az / (2. * PI) + .5, clamp(.5 + .5 * sign(el) * sqrt(abs(el) / (PI * .5)), .004, .996));
  // lifted towards the zenith (single scattering alone is too dark overhead)
  var c = textureSampleLevel(tSky, sRep, uv, 0.).rgb * E0 * mix(1., 1.8, sat(d.y * 1.4) * (1. - ss(.5, .97, dot(d, view.sun.xyz))));
  // pearl just above the horizon, warming to cream and gold (and higher) towards the low sun; mostly off at night,
  // where its warm cast reads as a strange red-brown band over the moonlit horizon
  let ts = ss(-.35, .95, dot(d.xz / max(length(d.xz), 1e-4), normalize(view.sun.xz)));
  let l = lum(c); c = mix(c, vec3f(l) * mix(vec3f(1.03, 1., .99), vec3f(1.2, 1., .72), ts) * 1.12, mix(.8, .9, ts) * (1. - ss(0., mix(.16, .3, ts), abs(d.y))) * (1. - .8 * view.night.x));
  return c;
}
// small cumulus on a flat layer 1.7 km up; lit sunward, grey-blue below
fn clouds(rd: vec3f, base: vec3f) -> vec3f {
  if (rd.y < .012) { return base; }
  let t = 1700. / (rd.y + .09); let p = rd.xz * t + view.cam.xz + vec2f(9., 4.) * view.cam.w;
  let q = p / 3400.;
  let sh = textureSampleLevel(tNoiseA, sRep, q * .23 + .21, 0.).r;
  let n = textureSampleLevel(tNoiseA, sRep, q, 0.).r * .62 + textureSampleLevel(tNoiseA, sRep, q * 3.1 + .4, 0.).r * .38;
  let cov = .63 - .11 * ss(.4, .62, sh);
  // puffs: a firm edge eaten by finer noise
  let dn = ss(cov, cov + .07, n - .05 * textureSampleLevel(tNoiseA, sRep, q * 9.7, 0.).a);
  if (dn <= 0.) { return base; }
  let sdir = normalize(view.sun.xz) * .016;
  let n2 = textureSampleLevel(tNoiseA, sRep, q + sdir, 0.).r * .62 + textureSampleLevel(tNoiseA, sRep, (q + sdir) * 3.1 + .4, 0.).r * .38;
  let lit = sat(.45 + (n - n2) * 14.) * (1. - .4 * dn) + .3;
  let mu = dot(rd, view.sun.xyz);
  let warm = view.sunc.rgb * (.13 + .5 * pow(sat(mu), 6.));
  let cool = skyLut(vec3f(-view.sun.x, .9, -view.sun.z)) * 1.5;
  let col = mix(cool, warm + cool * .6, lit);
  let far = exp(-t / 26000.);
  return mix(base, col, dn * .93 * far * ss(.012, .05, rd.y));
}
// stars: one faint point per sparse cell of a direction lattice. Static (no twinkle); the dot is ~half a pixel
// across, so TAA accumulates it steadily; ~6% of cells are filled, brightness spread over ~1.5 mag.
fn stars(rd: vec3f) -> vec3f {
  let q = rd * 140.; let id = floor(q);
  let r = h22(id.xy + vec2f(id.z * 61.7, id.z * 23.9)); if (r.x > .06) { return vec3f(0.); }
  let r2 = h21(vec2f(id.x * 7.3 + id.y * 3.1, id.z));
  let d = length((q - id) - vec3f(.2 + .6 * r.y, .2 + .6 * r2, .2 + .6 * fract(r.y * 7.7)));
  return vec3f(1., .97, .9) * exp(-d * d * 140.) * (.25 + .75 * r2);
}
fn sky(rd: vec3f, disc: bool) -> vec3f {
  var c = skyLut(rd);
  if (disc) {
    // disc and a soft round glare, no rays; night: a small hard moon (its sunc alone would be invisible) with a
    // faint blue halo, slightly blooming
    let mu = sat(dot(rd, view.sun.xyz));
    c += min(view.sunc.rgb * 900., vec3f(260.)) * ss(.99996, .999975, mu) + view.sunc.rgb * (pow(mu, 9000.) * 2.5 + pow(mu, 1800.) * .25 + pow(mu, 250.) * .02);
    if (view.night.x > .5) { c += vec3f(1., .99, .95) * 9. * ss(.999982, .99999, mu) + vec3f(.55, .65, .85) * (pow(mu, 8000.) * .15); }
  }
  // night: stars over the table, under the clouds
  if (view.night.x > .5) { c += stars(rd); }
  return clouds(rd, c);
}
`;

// environment cube for image-based lighting
// draw(3, 1, 0, face + 6 * mode): 0 sky (plus a lit ground below the horizon), 1 2x2 mip copy,
// 2-7 prefilter for roughness (mode - 2) / 5, 9 diffuse irradiance
const W_ENV = W_COMMON + /*wgsl*/`
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var sRep: sampler;
@group(0) @binding(2) var sLin: sampler;
@group(0) @binding(3) var tSky: texture_2d<f32>;
@group(0) @binding(4) var tNoiseA: texture_2d<f32>;
@group(0) @binding(5) var tSrc: texture_cube<f32>;
` + W_SKY + /*wgsl*/`
struct VO { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) k: u32 }
@vertex fn vs(@builtin(vertex_index) i: u32, @builtin(instance_index) k: u32) -> VO {
  let q = vec2f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1));
  return VO(vec4f(q, 0., 1.), q, k);
}
fn faceDir(f: u32, uv: vec2f) -> vec3f {
  let u = uv.x; let v = uv.y;
  switch f { case 0u { return vec3f(1., v, -u); } case 1u { return vec3f(-1., v, u); } case 2u { return vec3f(u, 1., -v); }
    case 3u { return vec3f(u, -1., v); } case 4u { return vec3f(u, v, 1.); } default { return vec3f(-u, v, -1.); } }
}
fn ham(i: u32, n: u32) -> vec2f { return vec2f(f32(i) / f32(n), f32(reverseBits(i)) * 2.3283064365386963e-10); }
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let face = i.k % 6u; let mode = i.k / 6u; let N = normalize(faceDir(face, i.uv));
  if (mode == 0u) {
    // below the horizon: sunlit stone, gardens and water, so undersides get a warm-aqua bounce
    let up = skyLut(vec3f(0., 1., 0.)) + skyLut(normalize(vec3f(-view.sun.z, .5, view.sun.x)));
    let gnd = vec3f(.36, .40, .37) * (view.sunc.rgb * view.sun.y + up * PI * .5) / PI;
    let s = sky(vec3f(N.x, max(N.y, .0), N.z), false);
    return vec4f(mix(gnd, s, ss(-.06, .01, N.y)), 1.);
  }
  if (mode == 1u) { return textureSampleLevel(tSrc, sLin, N, 0.); }
  var up = vec3f(0., 1., 0.); if (abs(N.y) > .99) { up = vec3f(1., 0., 0.); }
  let tx = normalize(cross(up, N)); let ty = cross(N, tx);
  var acc = vec3f(0.); var ws = 0.;
  if (mode == 9u) {
    for (var k = 0u; k < 256u; k++) { let h = ham(k, 256u); let ct = sqrt(1. - h.y); let st = sqrt(h.y); let ph = 2. * PI * h.x;
      acc += textureSampleLevel(tSrc, sLin, tx * st * cos(ph) + ty * st * sin(ph) + N * ct, 3.).rgb; }
    return vec4f(acc / 256., 1.);
  }
  let rough = f32(mode - 2u) / 5.; let a = rough * rough;
  for (var k = 0u; k < 96u; k++) {
    let h = ham(k, 96u); let ct = sqrt((1. - h.y) / (1. + (a * a - 1.) * h.y)); let st = sqrt(1. - ct * ct); let ph = 2. * PI * h.x;
    let H = tx * st * cos(ph) + ty * st * sin(ph) + N * ct; let L = 2. * dot(N, H) * H - N; let nl = dot(N, L);
    if (nl > 0.) {
      let d = a * a / (PI * sq(ct * ct * (a * a - 1.) + 1.)); let pdf = d / 4. + 1e-4;
      let lod = max(.5 * log2(6. * 256. * 256. / (96. * pdf * 4. * PI)) + 1., 0.);
      acc += min(textureSampleLevel(tSrc, sLin, L, lod).rgb, vec3f(60.)) * nl; ws += nl;
    }
  }
  return vec4f(acc / max(ws, 1e-4), 1.);
}
`;

// blits: mips and the bloom chain. blt: the first bloom step's threshold — day 0 (today's soft knee), night one
// high enough that only emissives (windows, the moon) clear it. main.js builds two modules from this.
const W_BLIT = (blt) => W_FS + /*wgsl*/`
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
fn uvOf(fc: vec4f, k: f32) -> vec2f { return fc.xy * k / vec2f(textureDimensions(t)); }
// stretch a texture over any target (history on resolution change)
struct Fit { @builtin(position) p: vec4f, @location(0) uv: vec2f }
@vertex fn vsFit(@builtin(vertex_index) i: u32) -> Fit { let q = vec2f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1)); return Fit(vec4f(q, 0., 1.), vec2f(q.x * .5 + .5, .5 - q.y * .5)); }
@fragment fn fsFit(i: Fit) -> @location(0) vec4f { return textureSampleLevel(t, s, i.uv, 0.); }
@fragment fn fsMip(@builtin(position) fc: vec4f) -> @location(0) vec4f { return textureSampleLevel(t, s, uvOf(fc, 2.), 0.); }
// first bloom step: taps weighted down by brightness, so one hot pixel can't flicker; BLT cuts everything below it
fn kar(c: vec3f) -> vec4f { let d = max(c - vec3f(${blt.toFixed(4)}), vec3f(0.)); let w = 1. / (1. + max(d.r, max(d.g, d.b))); return vec4f(d * w, w); }
@fragment fn fsDown0(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  let m = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.).rgb, vec3f(64.))) + kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.).rgb, vec3f(64.)))
        + kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.).rgb, vec3f(64.))) + kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.).rgb, vec3f(64.)));
  return vec4f(m.rgb / m.a, 1.);
}
@fragment fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
@fragment fn fsUp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, .5); let e = .75 / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
`;

// animated water texture (every frame, tiling)
// rg slope, b caustics, a filaments for the light-liquid; mipped so far water turns roughness, not sparkle
const W_WAVES = W_COMMON + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> u: vec4f;
fn hsh(p: vec2f) -> vec2f { var q = fract(vec3f(p.xyx) * vec3f(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
// sum of small waves; integer wave vectors keep the tile seamless
fn hgt(p: vec2f, t: f32) -> f32 {
  var h = 0.;
  for (var i = 0; i < 9; i++) {
    let r = hsh(vec2f(f32(i), 7.)); let a = r.x * 6.283; let f = 2. + f32(i) * 1.6; let k = round(vec2f(cos(a), sin(a)) * f);
    let ph = dot(k, p) * 6.283 + t * (1.1 + .5 * sqrt(length(k))) + r.y * 40.;
    h += (sin(ph) + .35 * sin(2. * ph + 1.3)) / (1.5 + length(k) * 1.2);
  }
  return h;
}
fn caus(p: vec2f, t: f32) -> f32 {
  var q = p * 6.283; var c = 0.;
  for (var i = 1; i <= 3; i++) {
    let f = f32(i); let w = vec2f(sin(q.y * f + t * (.5 + .12 * f)) + sin(q.x * 2. * f - t * .4), cos(q.x * f - t * (.45 + .1 * f)) + cos(q.y * 2. * f + t * .35));
    q += w * .5 / f; c += 1. / length(vec2f(sin(q.x * (f + 1.)), cos(q.y * (f + 1.))) * 2.2 + vec2f(.001));
  }
  return c / 3.;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = fc.xy / ${WAVEPX}.; let t = u.x; let e = 1. / 512.;
  let h = hgt(p, t); let sl = vec2f(hgt(p + vec2f(e, 0.), t) - h, hgt(p + vec2f(0., e), t) - h) / e * .012;
  let c = pow(sat(caus(p, t * 1.4) * .32), 1.7) * 2.6;
  // filaments: thin bright threads drifting along +x
  let q = vec2f(p.x - t * .03, p.y); var f = 0.;
  for (var i = 1; i <= 3; i++) { let fi = f32(i); let y = q.y * 6.283 * fi * 2. + 1.7 * sin(q.x * 6.283 * fi + fi * 2.1 + .5 * sin(t * .21 + fi)) + .6 * sin(q.x * 6.283 * 3. * fi + t * .13); f += pow(sat(1. - abs(sin(y)) * 3.5), 3.) * (.5 + .5 * sin(q.x * 6.283 * (fi + 1.) + fi)) / fi; }
  return vec4f(sl, c, f);
}
`;
