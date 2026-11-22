// shaders 4/4: water (after the lit opaque scene, which it refracts and reflects)
const W_FX = W_SCENE_VS + /*wgsl*/`
@group(1) @binding(0) var tScene: texture_2d<f32>; // lit scene behind (copy)
@group(1) @binding(1) var tDepth: texture_depth_2d; // its depth (copy)
@group(1) @binding(2) var tSky: texture_2d<f32>;
@group(1) @binding(3) var tEnv: texture_cube<f32>;
@group(1) @binding(4) var tSh0: texture_depth_2d;
@group(1) @binding(5) var tSh1: texture_depth_2d;
@group(1) @binding(6) var tSh2: texture_depth_2d;
@group(1) @binding(7) var tSh3: texture_depth_2d;
@group(1) @binding(8) var tWater: texture_2d<f32>;
@group(1) @binding(9) var sCmp: sampler_comparison;
` + W_SKY + W_SHADOWLIB + W_SHADE + /*wgsl*/`
fn viewZ(uv: vec2f) -> f32 { return view.fwd.w / max(textureLoad(tDepth, vec2i(clamp(uv, vec2f(0.), vec2f(.9999)) * view.res.xy), 0), 1e-7); }
fn worldAt(uv: vec2f, z: f32) -> vec3f { let ndc = uv * vec2f(2., -2.) + vec2f(-1., 1.) - view.jit.xy; return view.cam.xyz + (view.fwd.xyz + view.right.xyz * ndc.x * view.right.w + view.up.xyz * ndc.y * view.up.w) * z; }
fn toUV(p: vec3f) -> vec3f { let c = view.vp * vec4f(p, 1.); return vec3f(c.x / c.w * .5 + .5, .5 - c.y / c.w * .5, c.w); }
// SSR for water (ring pool, sea): march in growing steps, refine, fade at screen edges
fn ssr(p: vec3f, r: vec3f, nz: f32) -> vec4f {
  var t = .4; var st = .5 + nz * .5; var hit = false; var q = vec3f(0.);
  for (var k = 0; k < ${SSRN}; k++) {
    t += st; q = toUV(p + r * t);
    if (q.z <= 0. || q.x < 0. || q.x > 1. || q.y < 0. || q.y > 1.) { return vec4f(0.); }
    let d = viewZ(q.xy);
    if (q.z > d + .02) { if (q.z - d < max(st * 2.5, 1.5)) { hit = true; } break; }
    st *= ${QL(1.28, 1.48, 1.48)};
  }
  if (!hit) { return vec4f(0.); }
  var lo = t - st; var hi = t;
  for (var k = 0; k < 5; k++) { let m = (lo + hi) * .5; q = toUV(p + r * m); if (q.z > viewZ(q.xy)) { hi = m; } else { lo = m; } }
  q = toUV(p + r * hi);
  let e = min(min(q.x, 1. - q.x), min(q.y, 1. - q.y));
  return vec4f(textureSampleLevel(tScene, sLin, q.xy, 0.).rgb, ss(0., .08, e));
}
struct FO { @location(0) c: vec4f }
`;
const W_FX2 = /*wgsl*/`

// water
// uv.x: 0 canal water, 1 indigo light-liquid, 2 sea
@fragment fn fsWater(i: VO) -> FO {
  let kind = u32(i.uv.x * 255. + .5); let p = i.wp; let fc = i.clip.xy; let suv = fc * view.res.zw;
  let dx = dpdx(p.xz); let dy = dpdy(p.xz); let fw = max(length(dx), length(dy));
  let toC = view.cam.xyz - p; let dist = length(toC); let V = toC / dist; let rd = -V;
  let nz = ign(fc + view.jit.z * 5.588); let r = length(p.xz); let L = view.sun.xyz;
  // surface slope from the wave texture at two or three scales
  var sl = vec2f(0.); var rough2 = .0006;
  if (kind == 2u) {
    let dx = dx * 3.; let dy = dy * 3.; // softer than one pixel: the open sea must never sizzle
    // three chop layers, turned and scaled so tiles never align, on a long swell
    let r1 = mat2x2f(.8, .6, -.6, .8); let r2 = mat2x2f(.34, -.94, .94, .34); let tm = view.cam.w;
    // large drifting noise tile; lost fine waves become roughness below
    let a = textureSampleGrad(tNoiseN, sRep, p.xz / 173. + vec2f(.0031, .0017) * tm, dx / 173., dy / 173.).ba - .5;
    let b = r1 * (textureSampleGrad(tNoiseN, sRep, (p.xz * r1) / 67. - vec2f(.004, .0022) * tm, (dx * r1) / 67., (dy * r1) / 67.).rg - .5);
    let c = r2 * (textureSampleGrad(tNoiseN, sRep, (p.xz * r2) / 23. + vec2f(.009, -.005) * tm, (dx * r2) / 23., (dy * r2) / 23.).rg - .5);
    let d = textureSampleGrad(tNoiseN, sRep, p.zx / 7.3 + vec2f(-.017, .02) * tm, dx.yx / 7.3, dy.yx / 7.3).gr - .5;
    // the swell (the same trains that move the mesh), each until finer than a pixel
    let sw = seaWave(p.xz, vec4f(1.) / (vec4f(1.) + sq(fw * 1.3) * vec4f(.034, .09, .233, .616)));
    sl = a * .28 + b * .5 + c * .45 + d * .3 + sw.yz;
    // sub-pixel waves become roughness: far water is a silky sheen, not glitter
    rough2 = .004 + .05 * sat(fw / 3.) + .05 * sat(fw / 14.) + .05 * sat(fw / 60.);
  } else {
    let k = select(1., .45, kind == 1u);
    // three wave-tile layers at unrelated scales and angles, pushed by slow noise into calmer and livelier patches
    let n1 = textureSampleGrad(tNoiseA, sRep, p.xz / 71., dx / 71., dy / 71.).r; let n2 = textureSampleGrad(tNoiseA, sRep, p.zx / 53. + .37, dx.yx / 53., dy.yx / 53.).r;
    let q = p.xz + (vec2f(n1, n2) - .5) * 9.;
    let r1 = mat2x2f(.8, .6, -.6, .8); let r2 = mat2x2f(.34, -.94, .94, .34);
    let a = textureSampleGrad(tWater, sRep, q / 11.3, dx / 11.3, dy / 11.3).rg;
    let b = r1 * textureSampleGrad(tWater, sRep, (q * r1) / 5.9 + .31, (dx * r1) / 5.9, (dy * r1) / 5.9).rg;
    let c = r2 * textureSampleGrad(tWater, sRep, (q * r2) / 3.1 + .7, (dx * r2) / 3.1, (dy * r2) / 3.1).rg;
    sl = (a * .5 + b * .34 + c * .2) * k * (.6 + .9 * n2);
    rough2 = .0004 + (.006 * sat(fw / .9) + .004 * sat(fw / 2.5)) * k * k;
  }
  let N = normalize(vec3f(-sl.x, 1., -sl.y)); let nv = max(dot(N, V), 1e-3);
  let F = .02 + .98 * pow(1. - nv, 5.);
  // under the surface: the scene behind, bent and coloured by the water depth
  let zs = viewZ(suv); let zw = 1. / i.clip.w; let thick0 = max(zs - zw, 0.); // fragment w is 1 / view depth
  var uv2 = suv + N.xz * vec2f(1., -1.) * .035 * sat(thick0 * .6) / (1. + dist * .02);
  var z2 = viewZ(uv2); if (z2 < zw) { uv2 = suv; z2 = zs; }
  let bed = worldAt(uv2, z2); let path = max(z2 - zw, 0.) * dist / zw; let depth = max(p.y - bed.y, 0.);
  var under = textureSampleLevel(tScene, sLin, uv2, 0.).rgb; var sig: vec3f; var scat: vec3f; var sA = .2;
  // ambient in the body: night keeps the water black glass (the sky table is dim, but the moon's share is cut too)
  let amb = (skyLut(vec3f(0., 1., 0.)) * 1.6 + view.sunc.rgb * .12) * mix(1., .35, view.night.x);
  let shw = shadow(p, vec3f(0., 1., 0.));
  if (kind == 0u) { sig = vec3f(.26, .045, .04); scat = vec3f(.0, .035, .04) * amb; sA = .05; }
  else if (kind == 1u) { sig = vec3f(2.4, 3., 1.3); scat = vec3f(.011, .006, .12) * (.35 + .65 * shw); sA = 2.5; }
  else { sig = vec3f(.4, .08, .06); scat = vec3f(.001, .012, .028) * amb * (1. + 1.4 * sat(p.y * 2. + .15)); sA = .1; } // crests let more light through
  under = under * exp(-sig * (path + depth * .6)) + scat * (1. - exp(-sA * path));
  // what it mirrors: the sky, blurred by sub-pixel waves (far water a calm sheen), plus near SSR
  let R = reflect(rd, N); var refl: vec3f;
  let Rs = normalize(vec3f(R.x, abs(R.y) + .003, R.z));
  refl = textureSampleLevel(tEnv, sLin, Rs, clamp(sqrt(rough2) * 9., 0., 3.5)).rgb;
  if (LV < 2 && view.misc.y < .5 && fw < 1.5) { let h = ssr(p, Rs, nz); refl = mix(refl, h.rgb, h.a * (1. - ss(.7, 1.5, fw))); }
  if (kind == 1u) { refl *= vec3f(.2, .17, .5); } // dark mirror, violet cast
  var col = mix(under, refl, select(F, min(F, .55), kind == 1u));
  // dark line where water meets stone
  if (kind < 2u) { col *= mix(.5, 1., ss(0., .35, thick0)); }
  // sun glitter
  let sh = shw;
  let H = normalize(V + L); let a = max(rough2 * 2., .0008);
  col += view.sunc.rgb * sh * min(ggxD(sat(dot(N, H)), sqrt(a)) * ggxV(sat(dot(N, L)), nv, sqrt(a)), select(90., 30., kind == 2u)) * sat(dot(N, L)) * (.02 + .98 * pow(1. - sat(dot(V, H)), 5.));
  if (kind == 1u) {
    // light-liquid: three layers of violet and rose filaments drifting round the ring at their own speeds, stirred by a
    // swirl, with brightness waves and breathing. Whole-number texture turns around the ring avoid a seam where the angle wraps.
    let nt = select(select(select(82., 56., r < 80.), 46., r < 65.), 25., r < 50.); let an = atan2(p.z, p.x) / (2. * PI); let rv = r / 8.;
    let fdx = vec2f(fw / 30., 0.); let fdy = vec2f(0., fw / 30.); let tm = view.cam.w; let fl = tm * .03;
    let sw = textureSampleGrad(tNoiseA, sRep, vec2f(an * round(nt * .07), rv * .11) + vec2f(fl * .5, tm * .011), fdx, fdy).rg - .5;
    let f1 = textureSampleGrad(tNoiseA, sRep, vec2f(an * round(nt * .13), rv * .27) + vec2f(fl, tm * .004) + sw * .14 + sl * .05, fdx, fdy).b;
    let f2 = textureSampleGrad(tNoiseA, sRep, vec2f(an * round(nt * .21), rv * .43) + vec2f(fl * 1.7, .3 - tm * .009) - sw * .11 - sl * .04, fdx, fdy).b;
    let f3 = textureSampleGrad(tNoiseA, sRep, vec2f(an * round(nt * .47), rv * .93) + vec2f(fl * 2.8, tm * .017) + sw * .2, fdx * 2., fdy * 2.).b;
    let wave = .72 + .28 * sin(r * .22 - tm * 1.5 + sw.x * 5.);
    let glow = (f1 * .9 + f2 * .7 + f3 * .4) * wave * (.4 + 1.6 * exp(-r / 45.));
    col += mix(vec3f(.5, .28, 1.), vec3f(1., .4, .62), sat(f2 * 1.4)) * glow * .6 * (1. - F);
  } else if (kind == 2u) {
    // thin foam at the shore
    let f = textureSampleGrad(tNoiseA, sRep, p.xz / 5. + vec2f(view.cam.w * .02), dx / 5., dy / 5.);
    let edge = ss(.55, .0, depth + (f.r - .5) * .5 + .12 * sin(view.cam.w * .7 + f.a * 6.)) * ss(.25, .6, f.g + f.a * .5);
    col = mix(col, amb * .55 + view.sunc.rgb * sh * .22, edge * .8);
  }
  return FO(vec4f(aerial(col, view.cam.xyz, rd, dist), 1.));
}
`;
