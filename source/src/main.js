// renderer, camera and input
const $ = (id) => document.getElementById(id);
const canvas = $('c'), info = $('i'), body = document.body;
let dead = false; // the graphics device was lost
const say = (m, to) => { if (!dead) $('s').textContent = m; $('b').style.transform = `scaleX(${to})`; return new Promise((r) => setTimeout(r, AUTO ? 0 : 40)); };
// the adapter was chosen in quality.js
if (!adapter.features.has('indirect-first-instance')) fail('This graphics adapter lacks a WebGPU feature the scene needs (indirect-first-instance).');
const hasTS = adapter.features.has('timestamp-query');
const device = await adapter.requestDevice({ requiredFeatures: hasTS ? ['timestamp-query', 'indirect-first-instance'] : ['indirect-first-instance'] });
window.__info = `${adapter.info.vendor} · ${adapter.info.architecture} · ${adapter.info.description}${adapter.info.isFallbackAdapter ? ' · FALLBACK (software)' : ''} · ${LVN[LV]}`;
device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message.slice(0, 900)));
// device lost (out of memory, driver reset): restart a level lower; on Low, say so. atlasLost tells the next load
// why it may get no adapter (cleared once a load survives)
device.lost.then((l) => {
  if (l.reason === 'destroyed') return; // the page is closing
  console.error(`device lost while "${$('s').textContent}": ${l.message}`); keep('atlasLost', 1);
  if (LV < 2 && !AUTO && !QP.has('lv')) { keep('atlas', LV + 1); location.reload(); }
  dead = true; body.className = 'l e'; $('s').textContent = 'The graphics device was lost. Reload the page to try again, or restart the browser if that fails.';
});
const ctx = canvas.getContext('webgpu'), FMT = navigator.gpu.getPreferredCanvasFormat();
const Q = device.queue, HDR = 'rgba16float', DEPTH = 'depth32float';
const TU = GPUTextureUsage, BU = GPUBufferUsage, SS = GPUShaderStage, VF = SS.VERTEX | SS.FRAGMENT;
const RT = TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING;

// shader module; compile errors are logged with their line
const mod = (code, name) => {
  const m = device.createShaderModule({ code });
  m.getCompilationInfo().then((i) => { for (const e of i.messages) if (e.type === 'error') console.error(`WGSL ${name}:${e.lineNum}: ${e.message}\n  ${code.split('\n')[e.lineNum - 1]?.slice(max(0, e.linePos - 80), e.linePos + 80)}`); });
  return m;
};
const buf = (data, usage) => { const b = device.createBuffer({ size: max(16, (data.byteLength + 3) & ~3), usage: usage | BU.COPY_DST }); Q.writeBuffer(b, 0, data.buffer || data, data.byteOffset || 0, data.byteLength); return b; };
const tex = (w, h, format, usage, o = {}) => device.createTexture({ size: [w, h, o.layers || 1], format, usage, mipLevelCount: o.mips || 1 });
// bind group layout from binding kinds: u uniform, r/w storage, s sampler, c comparison sampler, t texture, d depth, k cube
const layout = (spec, visibility = VF) => device.createBindGroupLayout({ entries: [...spec].map((t, binding) => ({ binding, visibility,
  ...(t === 'u' ? { buffer: {} } : t === 'r' ? { buffer: { type: 'read-only-storage' } } : t === 'w' ? { buffer: { type: 'storage' } } : t === 's' ? { sampler: {} } : t === 'c' ? { sampler: { type: 'comparison' } }
    : t === 'd' ? { texture: { sampleType: 'depth' } } : t === 'k' ? { texture: { viewDimension: 'cube' } } : { texture: {} }) })) });
const group = (lay, res) => device.createBindGroup({ layout: lay, entries: res.map((r, binding) => ({ binding, resource: r instanceof GPUBuffer ? { buffer: r } : r instanceof GPUTexture ? r.createView() : r })) });
const plOf = (...l) => device.createPipelineLayout({ bindGroupLayouts: l });
const colorAtt = (view, clear) => ({ view, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] });
const fsPipe = (m, lay, format, entry = 'fs', blend) => device.createRenderPipeline({ layout: plOf(lay), vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: entry, targets: [{ format, blend }] } });

// samplers, detail textures
const sRep = device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: QL(8, 4, 1) });
const sLin = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: QL(4, 2, 1) }); // anisotropic detail sampling
const sCmp = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
const lBlit = layout('ts', SS.FRAGMENT), mBlit = mod(W_BLIT(0), 'blit'), mBlitN = mod(W_BLIT(2.5), 'blitN'); // night: bloom threshold
const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
const blitPipe = (entry, format, blend, m = mBlit) => fsPipe(m, lBlit, format, entry, blend);
const pMip = { rgba8unorm: blitPipe('fsMip', 'rgba8unorm'), [HDR]: blitPipe('fsMip', HDR), r16float: blitPipe('fsMip', 'r16float') };
const pDown0 = blitPipe('fsDown0', HDR), pDown0N = blitPipe('fsDown0', HDR, undefined, mBlitN), pDown = blitPipe('fsDown', HDR), pUp = blitPipe('fsUp', HDR, ADD);
const blitBG = (view) => group(lBlit, [view, sLin]);
const mipView = (t, m) => t.createView({ baseMipLevel: m, mipLevelCount: 1 });
const genMips = (e, t) => { for (let i = 1; i < t.mipLevelCount; i++) { const r = e.beginRenderPass({ colorAttachments: [colorAtt(mipView(t, i), true)] }); r.setPipeline(pMip[t.format]); r.setBindGroup(0, blitBG(mipView(t, i - 1))); r.draw(3); r.end(); } };
// load checkpoint: wait for the GPU so work never piles up on a slow chip (?log prints timings)
const T0 = performance.now(), ck = async (m) => { await Q.onSubmittedWorkDone(); if (QP.has('log')) console.log(`${((performance.now() - T0) / 1000).toFixed(2)} s  ${m}`); };
await say('Mixing marble…', 0.05);
const mipsOf = (n) => 32 - Math.clz32(n); // full mip chain length for size n
const tNoiseA = tex(NOISEPX, NOISEPX, 'rgba8unorm', RT, { mips: mipsOf(NOISEPX) }), tNoiseN = tex(NOISEPX, NOISEPX, 'rgba8unorm', RT, { mips: mipsOf(NOISEPX) });
{
  const m = mod(W_NOISE, 'noise');
  for (const [t, entry] of [[tNoiseA, 'fsA'], [tNoiseN, 'fsN']]) {
    const p = device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: entry, targets: [{ format: 'rgba8unorm' }] } });
    const e = device.createCommandEncoder(), r = e.beginRenderPass({ colorAttachments: [colorAtt(mipView(t, 0), true)] }); r.setPipeline(p); r.draw(3); r.end(); genMips(e, t);
    Q.submit([e.finish()]); await ck(entry);
  }
}
// animated water texture
const tWater = tex(WAVEPX, WAVEPX, HDR, RT, { mips: 6 });
const WT = new Float32Array(4), uboW = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
const lWaves = layout('u', SS.FRAGMENT), pWaves = fsPipe(mod(W_WAVES, 'waves'), lWaves, HDR), bgWaves = group(lWaves, [uboW]);
const waterBG = [0, 1, 2, 3, 4].map((m) => blitBG(mipView(tWater, m)));

// views
// main and shadow views each have a uniform block (struct View in sh_base.js)
const NU = 216, V_MAIN = 0, V_SH = 1;
const UB = [0, 1].map(() => new Float32Array(NU)), ubo = UB.map(() => device.createBuffer({ size: NU * 4, usage: BU.UNIFORM | BU.COPY_DST }));
const O_SM = 48, O_CAM = 112, O_RES = 116, O_JIT = 120, O_SUN = 124, O_SUNC = 128, O_RIGHT = 132, O_UP = 136, O_FWD = 140, O_PL = 144, O_MISC = 172, O_LODC = 176, O_LODB = 180, O_NIGHT = 184;
const TANH = tan(30 * DEG), NEAR = 0.3, EXPO = 0.8, EXPO_N = 0.55;
// light profile: 0 golden-hour day, 1 night. ?night=1|0 forces one (headless tests); else the stored choice, day default
let night = 0;
try { const nq = QP.get('night'); night = nq !== null ? +(nq === '1') : AUTO ? 0 : +(localStorage.atlasNight === '1'); } catch {}
// windows, window bays and doors: hidden by default (the facade reads cleaner); ?win=1|0 forces
// one for headless probes, otherwise the saved drawer choice. Toggling only gates K.GLASS draws.
let windows = 0;
try { const wq = QP.get('win'); windows = wq !== null ? +(wq === '1') : AUTO ? 0 : +(localStorage.atlasWin === '1'); } catch {}
// two independent label layers: house numbers and street names. Both on by default; ?num / ?street
// force a value (headless probes), otherwise the saved drawer choice. DOM overlay, no rebuild.
let showNum = 1, showStreet = 1;
try { const nq = QP.get('num'), sq = QP.get('street');
  showNum = nq !== null ? +(nq === '1') : AUTO ? 1 : localStorage.atlasNum !== '0';
  showStreet = sq !== null ? +(sq === '1') : AUTO ? 1 : localStorage.atlasStreet !== '0';
} catch {}
// sun at the ground: atmospheric transmittance x 1.35 (keeps sunlit paving warm rather than grey); night: the moon.
// Strict physics (the task brief's 1/4e4) renders black under AgX at the night exposure, so the moon carries
// ~1/200 of the sun (MOONGROUND) and the night sky table is lifted to a visible dark blue (MOONSKY) — art-directed.
const AT = atmo(SUN), SUNC = AT.Ts.map((t) => t * E0 * 1.35);
const ATN = atmo(NIGHT_SUN), SUNCN = ATN.Ts.map((t, c) => t * E0 * MOONGROUND * MOONTINT[c]);
if (AUTO) console.log('sun at ground ' + SUNC.map((v) => v.toFixed(2)) + ' · psi ' + AT.PSI.map((v) => v.toFixed(4)) + ' · moon ' + SUNCN.map((v) => v.toFixed(3)));
// per view, the light profile's sun, sun colour, exposure and night flag (one writer, so the toggle is one call)
const setViewSun = (U, n) => { U.set(n ? NIGHT_SUN : SUN, O_SUN); U.set(n ? SUNCN : SUNC, O_SUNC); U[O_SUNC + 3] = n ? EXPO_N : EXPO; U[O_NIGHT] = n; };
for (const U of UB) { setViewSun(U, night); U[O_MISC + 2] = 1; U[O_LODC + 3] = 1; }
// camera matrices and frustum planes for a view at (cx, cy, cz), yaw / pitch
function setCam(U, cx, cy, cz, yaw, pitch, W, H, jx, jy) {
  const cp = cos(pitch), fy = sin(pitch), rx = cos(yaw), rz = sin(yaw), fx = cp * rz, fz = -cp * rx;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy, asp = W / H, tx = TANH * asp, sx = 1 / tx, sy = 1 / TANH;
  const tw = -(fx * cx + fy * cy + fz * cz), ox = -(rx * cx + rz * cz) * sx, oy = -(ux * cx + uy * cy + uz * cz) * sy;
  // reversed depth, far plane at infinity; (jx, jy): sub-pixel jitter
  U[0] = rx * sx + jx * fx; U[4] = jx * fy; U[8] = rz * sx + jx * fz; U[12] = ox + jx * tw;
  U[1] = ux * sy + jy * fx; U[5] = uy * sy + jy * fy; U[9] = uz * sy + jy * fz; U[13] = oy + jy * tw;
  U[2] = 0; U[6] = 0; U[10] = 0; U[14] = NEAR;
  U[3] = fx; U[7] = fy; U[11] = fz; U[15] = tw;
  U[O_CAM] = cx; U[O_CAM + 1] = cy; U[O_CAM + 2] = cz;
  U[O_RES] = W; U[O_RES + 1] = H; U[O_RES + 2] = 1 / W; U[O_RES + 3] = 1 / H; U[O_JIT] = jx; U[O_JIT + 1] = jy;
  U[O_RIGHT] = rx; U[O_RIGHT + 1] = 0; U[O_RIGHT + 2] = rz; U[O_RIGHT + 3] = tx;
  U[O_UP] = ux; U[O_UP + 1] = uy; U[O_UP + 2] = uz; U[O_UP + 3] = TANH;
  U[O_FWD] = fx; U[O_FWD + 1] = fy; U[O_FWD + 2] = fz; U[O_FWD + 3] = NEAR;
  const lx = 1 / sqrt(tx * tx + 1), ly = 1 / sqrt(TANH * TANH + 1);
  plane(U, 0, (fx * tx + rx) * lx, fy * tx * lx, (fz * tx + rz) * lx, cx, cy, cz, 0); plane(U, 1, (fx * tx - rx) * lx, fy * tx * lx, (fz * tx - rz) * lx, cx, cy, cz, 0);
  plane(U, 2, (fx * TANH + ux) * ly, (fy * TANH + uy) * ly, (fz * TANH + uz) * ly, cx, cy, cz, 0); plane(U, 3, (fx * TANH - ux) * ly, (fy * TANH - uy) * ly, (fz * TANH - uz) * ly, cx, cy, cz, 0);
  plane(U, 4, fx, fy, fz, cx, cy, cz, 0); plane(U, 5, 0, 0, 0, 0, 0, 0, 1e9);
}
function plane(U, k, nx, ny, nz, px, py, pz, w) { const o = O_PL + k * 4; U[o] = nx; U[o + 1] = ny; U[o + 2] = nz; U[o + 3] = w - (nx * px + ny * py + nz * pz); }
// sun shadow matrix: a box of half width R around (cx, cy, cz), written at float offset `at` of every view; with
// `cull` also the shadow view's own matrix and planes. The active light follows the day/night profile: the toggle
// swaps ACTIVE_SUN (and the map basis LR/LU with it), so the per-frame cascade and the bakes all track it. `views`
// false leaves the main copy alone (bakes run while the active profile is still on screen).
let ACTIVE_SUN = night ? NIGHT_SUN : SUN;
let LR = vnorm([ACTIVE_SUN[2], 0, -ACTIVE_SUN[0]]), LU = vcross(ACTIVE_SUN, LR);
function shadowMat(at, cx, cy, cz, R, d0, d1, size, cull, views = true) {
  // snap to whole texels so the map doesn't crawl
  const tx = 2 * R / size, px = round((LR[0] * cx + LR[1] * cy + LR[2] * cz) / tx) * tx, py = round((LU[0] * cx + LU[1] * cy + LU[2] * cz) / tx) * tx, pz = ACTIVE_SUN[0] * cx + ACTIVE_SUN[1] * cy + ACTIVE_SUN[2] * cz, D = d1 - d0, m = UB[V_SH];
  for (let i = 0; i < 3; i++) { m[at + i * 4] = LR[i] / R; m[at + i * 4 + 1] = LU[i] / R; m[at + i * 4 + 2] = -ACTIVE_SUN[i] / D; m[at + i * 4 + 3] = 0; }
  m[at + 12] = -px / R; m[at + 13] = -py / R; m[at + 14] = (d1 + pz) / D; m[at + 15] = 1;
  if (views) { for (let i = 0; i < 16; i++) UB[V_MAIN][at + i] = m[at + i]; }
  if (cull) {
    for (let i = 0; i < 16; i++) m[i] = m[at + i];
    plane(m, 0, LR[0], LR[1], LR[2], 0, 0, 0, R - px); plane(m, 1, -LR[0], -LR[1], -LR[2], 0, 0, 0, R + px);
    plane(m, 2, LU[0], LU[1], LU[2], 0, 0, 0, R - py); plane(m, 3, -LU[0], -LU[1], -LU[2], 0, 0, 0, R + py);
    plane(m, 4, 0, 0, 0, 0, 0, 0, 1e9); plane(m, 5, 0, 0, 0, 0, 0, 0, 1e9);
  }
}

// sky table and environment light (baked once per profile: day sun, night moon — 2x the bake cost, ~+0.1-0.2 s)
await say('Lighting the sky…', 0.1);
const tSky = tex(256, 128, HDR, RT), tSkyN = tex(256, 128, HDR, RT);
const tEnvRaw = tex(256, 256, HDR, RT, { layers: 6, mips: 9 }), tEnvRawN = tex(256, 256, HDR, RT, { layers: 6, mips: 9 });
const tEnv = tex(256, 256, HDR, RT, { layers: 6, mips: 6 }), tEnvN = tex(256, 256, HDR, RT, { layers: 6, mips: 6 });
const tIrr = tex(16, 16, HDR, RT, { layers: 6 }), tIrrN = tex(16, 16, HDR, RT, { layers: 6 });
const cubeView = (t, o = {}) => t.createView({ dimension: 'cube', ...o });
const cvEnv = cubeView(tEnv), cvIrr = cubeView(tIrr), cvEnvN = cubeView(tEnvN), cvIrrN = cubeView(tIrrN);
const bakeSkyEnv = async (at, sun, label, tS, tER, tE, tI) => {
  // the bake reads view.sun/sunc/night (sky azimuth, ground bounce, stars): the caller sets them per profile
  const ms = mod(W_SKYLUT(at, sun, sun === NIGHT_SUN ? MOONSKY : 1, sun === NIGHT_SUN ? MOONTINT : [1, 1, 1]), 'skylut');
  let e = device.createCommandEncoder();
  const flush = async (m) => { Q.submit([e.finish()]); await ck(m); e = device.createCommandEncoder(); };
  let r = e.beginRenderPass({ colorAttachments: [colorAtt(tS.createView(), true)] });
  r.setPipeline(device.createRenderPipeline({ layout: 'auto', vertex: { module: ms, entryPoint: 'vs' }, fragment: { module: ms, entryPoint: 'fs', targets: [{ format: HDR }] } })); r.draw(3); r.end();
  Q.writeBuffer(ubo[V_MAIN], 0, UB[V_MAIN]); await flush(label + 'sky table');
  const lEnv = layout('ussttk', VF), me = mod(W_ENV, 'env');
  const pEnv = device.createRenderPipeline({ layout: plOf(lEnv), vertex: { module: me, entryPoint: 'vs' }, fragment: { module: me, entryPoint: 'fs', targets: [{ format: HDR }] } });
  const face = (t, f, m) => t.createView({ dimension: '2d', baseArrayLayer: f, arrayLayerCount: 1, baseMipLevel: m, mipLevelCount: 1 });
  const pass = (dst, f, m, mode, src) => { r = e.beginRenderPass({ colorAttachments: [colorAtt(face(dst, f, m), true)] }); r.setPipeline(pEnv); r.setBindGroup(0, group(lEnv, [ubo[V_MAIN], sRep, sLin, tS, tNoiseA, src])); r.draw(3, 1, 0, f + 6 * mode); r.end(); };
  // raw sky into mip 0 (the bound source is a stand-in mode 0 never samples), then its mips
  for (let f = 0; f < 6; f++) pass(tER, f, 0, 0, cubeView(tI));
  for (let m = 1; m < 9; m++) for (let f = 0; f < 6; f++) pass(tER, f, m, 1, cubeView(tER, { baseMipLevel: m - 1, mipLevelCount: 1 }));
  await flush(label + 'sky cube');
  for (let m = 0; m < 6; m++) { for (let f = 0; f < 6; f++) pass(tE, f, m, 2 + m, cubeView(tER)); await flush(label + 'sky cube, roughness ' + m); }
  for (let f = 0; f < 6; f++) pass(tI, f, 0, 9, cubeView(tER));
  await flush(label + 'sky irradiance');
};
setViewSun(UB[V_MAIN], 0); await bakeSkyEnv(AT, SUN, '', tSky, tEnvRaw, tEnv, tIrr);
setViewSun(UB[V_MAIN], 1); await bakeSkyEnv(ATN, NIGHT_SUN, 'night ', tSkyN, tEnvRawN, tEnvN, tIrrN);
setViewSun(UB[V_MAIN], night);

// the world: meshes, instances, levels of detail
await say('Raising the city…', 0.2);
keep('atlasLoad', 1);
addEventListener('pagehide', () => keep('atlasLoad', ''));
await say('Loading map pack…', 0.18);
await loadPack();
if (PK.h.poses) POSES = PK.h.poses; // viewpoints for keys 1-6 come from the pack when it has them
if (PK.h.fly) FLY = Float32Array.from(PK.h.fly); // the pack's fly-through replaces the default lap
const Wd = await buildWorld(PK);
landY = Wd.ground; setHard(Wd.hard); setBoxes(Wd.bboxes); // collision ground, old shape lists (empty), building boxes
const MK = mkMarker(Wd); // vehicle marker: mesh + type + one ALWAYS instance through the world's own type()/put()
await say('Planting gardens…', 0.7);
let nV = 0, nIx = 0;
for (const m of Wd.meshes) { m.v0 = nV; m.i0 = nIx; m.ni = m.ib.length; nV += m.nv; nIx += m.ni; }
// upload each mesh separately and drop it, so geometry never sits in memory twice (phones)
const vbMesh = device.createBuffer({ size: max(16, nV * 20), usage: BU.VERTEX | BU.COPY_DST }), ibMesh = device.createBuffer({ size: max(16, nIx * 4), usage: BU.INDEX | BU.COPY_DST });
for (const m of Wd.meshes) { if (m.nv) Q.writeBuffer(vbMesh, m.v0 * 20, m.vb); if (m.ni) Q.writeBuffer(ibMesh, m.i0 * 4, m.ib); m.vb = m.ib = null; }
const bInst = buf(new Uint8Array(Wd.nI * 48 + 48), BU.STORAGE); Q.writeBuffer(bInst, 0, Wd.inst); // extra slot: the vehicle marker
markerBuf(bInst, MK * 48); gpsStart(); // marker's instance slot; then GPS per the query params
await ck('geometry');
// ?types lists every mesh type: kind, instances, triangles per LOD, distances
if (AUTO && QP.has('types')) console.log(Wd.types.map((t, i) => ((i > 2 && i < 99) || (t.n < 6 && Wd.meshes[t.lods[0]].ni < 9000) || (QP.get('types') === 'big' && i < 135) ? '' : `${i}:k${t.kind} n${t.n} [${t.lods.map((l) => Wd.meshes[l].ni / 3).join('/')}] d${t.d.map((v) => (v > 1e8 ? '-' : v)).join(',')}  `)).join(''));
if (AUTO) console.log(`${Wd.meshes.length} meshes · ${(nV / 1e6).toFixed(2)} M vertices · ${(nIx / 3e6).toFixed(2)} M triangles · ${Wd.nI + 1} instances (1 marker) · ${((nV * 20 + nIx * 4 + Wd.nI * 48 + 48) / 1048576).toFixed(0)} MB`);
// one slot per (mesh type, LOD): a range of the visible list and one indirect draw
const slots = [], NONE = 0xffffffff;
const tyData = new ArrayBuffer(Wd.types.length * 48), tyU = new Uint32Array(tyData), tyF = new Float32Array(tyData); // struct MType in sh_scene.js
let nVis = 0;
Wd.types.forEach((t, i) => {
  for (let l = 0; l < 4; l++) { if (l < t.lods.length) { tyU[i * 12 + l] = slots.length; slots.push({ mesh: Wd.meshes[t.lods[l]], kind: t.kind, flags: t.flags, first: nVis, n: t.n, lod: l }); nVis += t.n; } else tyU[i * 12 + l] = NONE; }
  tyF.set(t.d, i * 12 + 4); tyF[i * 12 + 8] = t.d23;
});
const argData = new Uint32Array(slots.length * 5);
slots.forEach((s, i) => argData.set([s.mesh.ni, 0, s.mesh.i0, s.mesh.v0, s.first], i * 5));
const bTypes = buf(new Uint8Array(tyData), BU.STORAGE);
const bArgs = [0, 1].map(() => buf(argData, BU.STORAGE | BU.INDIRECT | BU.COPY_SRC)), bVis = [0, 1].map(() => device.createBuffer({ size: max(16, nVis * 4), usage: BU.STORAGE }));
const lCull = layout('urrww', SS.COMPUTE), mCull = mod(W_CULL, 'cull');
const pReset = device.createComputePipeline({ layout: plOf(lCull), compute: { module: mCull, entryPoint: 'reset' } }), pCull = device.createComputePipeline({ layout: plOf(lCull), compute: { module: mCull, entryPoint: 'cull' } });
const bgCull = [0, 1].map((v) => group(lCull, [ubo[v], bInst, bTypes, bArgs[v], bVis[v]]));
const NG_R = ceil(slots.length / 64), NG_C = ceil((Wd.nI + 1) / 64); // +1: the marker instance
// slot lists per kind; `skip` leaves out types flagged against a view
const listOf = (kind, skip = 0, need = 0) => new Uint32Array(slots.map((s, i) => (s.kind === kind && !(s.flags & skip) && (s.flags & need) === need ? i : -1)).filter((i) => i >= 0));
// one entry per kind the world registers, indexed by the world's kind constants (world.js). gnd: the ground,
// drawn last so covered pixels are never shaded; near / cast: camera cascade and baked maps
const LS = [];
for (const k of [K.SOLID, K.WATER, K.GLASS]) LS[k] = { all: listOf(k, DRAW_LAST), gnd: listOf(k, 0, DRAW_LAST), near: listOf(k, NO_NEAR | NO_SHADOW), cast: listOf(k, NO_SHADOW | NO_BAKE) };
const tMap = tex(MAPPX, MAPPX, 'rgba8unorm', RT | TU.COPY_DST, { mips: 5 });
const tLand = tex(MAPPX, MAPPX, 'rgba8unorm', RT | TU.COPY_DST, { mips: 5 });
// ground maps are painted at 1 m/texel; Low uploads them at half size (mean of four)
const mapOf = (a) => {
  if (MAPPX === 2048) return a;
  const o = new Uint8Array(MAPPX * MAPPX * 4);
  for (let j = 0; j < 1024; j++) for (let i = 0; i < 1024; i++) for (let c = 0; c < 4; c++) { const s = (j * 4096 + i * 2) * 4 + c; o[(j * 1024 + i) * 4 + c] = (a[s] + a[s + 4] + a[s + 8192] + a[s + 8196] + 2) >> 2; }
  return o;
};
Q.writeTexture({ texture: tMap }, mapOf(Wd.MAP), { bytesPerRow: MAPPX * 4 }, [MAPPX, MAPPX]); Q.writeTexture({ texture: tLand }, mapOf(Wd.LANDMAP), { bytesPerRow: MAPPX * 4 }, [MAPPX, MAPPX]); Wd.MAP = Wd.LANDMAP = null;
{ const e = device.createCommandEncoder(); genMips(e, tMap); genMips(e, tLand); Q.submit([e.finish()]); }
await ck('ground maps');

// scene pipelines
const lScene = layout('ussrrtttt'), lFx = layout('tdtkddddtc', SS.FRAGMENT), plScene = plOf(lScene), plFx = plOf(lScene, lFx);
const bgScene = [0, 1].map((v) => group(lScene, [ubo[v], sRep, sLin, bInst, bVis[v], tNoiseA, tNoiseN, tMap, tLand]));
const A = (shaderLocation, offset, format) => ({ shaderLocation, offset, format });
const vbLay = [{ arrayStride: 20, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4'), A(2, 16, 'unorm8x4')] }];
const mG = mod(LV > 1 ? W_GBUF_LOW : W_GBUF, 'gbuf'), mSh = mod(W_SHADOW, 'shadow'), mFx = mod(W_FX + W_FX2, 'fx');
const gPipe = (cull) => device.createRenderPipeline({ layout: plScene, vertex: { module: mG, entryPoint: 'vs', buffers: vbLay },
  fragment: { module: mG, entryPoint: 'fs', targets: ['rgba8unorm', HDR, 'rgba8unorm'].map((format) => ({ format, writeMask: 15 })) },
  primitive: { cullMode: cull }, depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'greater' } });
const pG = gPipe('back');
const shPipe = (format) => device.createRenderPipeline({ layout: plScene, vertex: { module: mSh, entryPoint: 'vs', buffers: vbLay },
  primitive: { cullMode: 'back' }, depthStencil: { format, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.2 } });
const pWater = device.createRenderPipeline({ layout: plFx, vertex: { module: mFx, entryPoint: 'vs', buffers: vbLay },
  fragment: { module: mFx, entryPoint: 'fsWater', targets: [{ format: HDR }] }, primitive: { cullMode: 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'greater' } });

// shadow maps: three baked, one following the camera
await ck('scene pipelines');
await say('Casting shadows…', 0.8);
// sizes: SHN in quality.js; with no cascade one texel stands in
const D16 = 'depth16unorm', DFAR = SH32 ? DEPTH : D16;
const tSh = [tex(SHN[0] || 1, SHN[0] || 1, DEPTH, RT), tex(SHN[1], SHN[1], D16, RT), tex(SHN[2], SHN[2], DFAR, RT), tex(SHN[3], SHN[3], DFAR, RT)];
// the night profile's baked maps: allocated now (two sets fit), filled by the first switch to night
const tShN = [tSh[0], tex(SHN[1], SHN[1], D16, RT), tex(SHN[2], SHN[2], DFAR, RT), tex(SHN[3], SHN[3], DFAR, RT)];
const shReady = [false, false]; // per profile: its baked maps are valid (the camera cascade tSh[0] is shared)
const pSh32 = CASC ? shPipe(DEPTH) : null, pSh16 = shPipe(D16), pShFar = SH32 ? pSh32 : pSh16, tTop = tex(TOPPX, TOPPX, 'r16float', RT, { mips: 8 });
const depthPass = (t, clear = true) => ({ colorAttachments: [], depthStencilAttachment: { view: t.createView(), depthClearValue: 1, depthLoadOp: clear ? 'clear' : 'load', depthStoreOp: 'store' } });
const drawList = (r, v, list) => { for (let i = 0; i < list.length; i++) r.drawIndexedIndirect(bArgs[v], list[i] * 20); };
const cullView = (c, v) => { c.setBindGroup(0, bgCull[v]); c.setPipeline(pReset); c.dispatchWorkgroups(NG_R); c.setPipeline(pCull); c.dispatchWorkgroups(NG_C); };
// draw the solid casters into a depth map with the shadow view's matrix (water casts nothing; foliage, crystal and
// glass casters were Atlantis scene furniture). Baked maps (half width R) are drawn as BAKEN x BAKEN tiles, each
// waited for: phone GPUs bin a pass's triangles first and crash on millions. A, B: the map's world axes.
const BAKEN = QL(1, mob ? 4 : 1, 4); // a phone on Medium needs tiles too
const castInto = async (t, pipe, R = 0, A = LR, B = LU) => {
  const n = R ? BAKEN : 1, U = UB[V_SH], sz = t.width / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (n > 1) {
      const a0 = R * (2 * i / n - 1), a1 = a0 + 2 * R / n, b0 = R * (2 * j / n - 1), b1 = b0 + 2 * R / n;
      plane(U, 0, A[0], A[1], A[2], 0, 0, 0, -a0); plane(U, 1, -A[0], -A[1], -A[2], 0, 0, 0, a1); plane(U, 2, B[0], B[1], B[2], 0, 0, 0, -b0); plane(U, 3, -B[0], -B[1], -B[2], 0, 0, 0, b1);
    }
    Q.writeBuffer(ubo[V_SH], 0, U);
    const e = device.createCommandEncoder(), c = e.beginComputePass(); cullView(c, V_SH); c.end();
    const r = e.beginRenderPass(depthPass(t, i + j === 0)); r.setBindGroup(0, bgScene[V_SH]); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32');
    if (n > 1) r.setScissorRect(sz * i, sz * (n - 1 - j), sz, sz);
    r.setPipeline(pipe); drawList(r, V_SH, LS[K.SOLID].cast); r.end(); Q.submit([e.finish()]);
    if (n > 1) await ck(`bake ${t.width} tile ${i},${j}`);
  }
};
// one profile's three baked maps (city, shelf, mountains): shadowMat with `views` false leaves the main
// matrix alone, so the frames of the active profile stay right while the other profile fills its textures
const bakeShadowMaps = async (dst) => {
  const U = UB[V_SH]; U[O_MISC + 1] = 2; U[O_MISC + 2] = 0; U[O_MISC + 3] = 0; U[O_LODC] = 0; U[O_LODC + 1] = 0; U[O_LODC + 2] = 0;
  // each map draws only what lies inside its own box seen from the sun (planes set by shadowMat). Medium/Low never cast
  // at the finest LOD (lodb): a 23 cm texel can't tell them apart.
  U[O_LODB] = QL(0, mob ? 250 : 100, 250);
  shadowMat(O_SM + 16, 0, 0, 0, 480, -900, 900, SHN[1], true, false); await castInto(dst[1], pSh16, 480); await Q.onSubmittedWorkDone();
  shadowMat(O_SM + 32, 0, 0, 0, 1400, -2600, 2600, SHN[2], true, false); U[O_MISC + 2] = 0.2; await castInto(dst[2], pShFar, 1400); await Q.onSubmittedWorkDone();
  shadowMat(O_SM + 48, 0, 0, 0, 6800, -9000, 9000, SHN[3], true, false); U[O_MISC + 2] = 1; await castInto(dst[3], pShFar, 6800); await Q.onSubmittedWorkDone();
};
const tShT0 = performance.now();
await bakeShadowMaps(night ? tShN : tSh); shReady[night] = true;
if (QP.has('log')) console.log(`shadow bake (${night ? 'night' : 'day'} sun) ${((performance.now() - tShT0) / 1000).toFixed(2)} s`);
// the bake writes the map matrices into the shadow view only, and the light pass reads them from
// the main view: without this copy the far maps sampled with zero matrices — shadows existed only
// inside the camera cascade and flickered in and out as the cascade swept over the district
shadowMat(O_SM + 16, 0, 0, 0, 480, -900, 900, SHN[1], true);
shadowMat(O_SM + 32, 0, 0, 0, 1400, -2600, 2600, SHN[2], true);
shadowMat(O_SM + 48, 0, 0, 0, 6800, -9000, 9000, SHN[3], true);
{
  const U = UB[V_SH];
  // top-down height map for sky visibility: +-512 m, heights -60 .. 200 m (sun-independent: baked once)
  U.fill(0, 0, 16); U[0] = 1 / 512; U[9] = -1 / 512; U[6] = -1 / 260; U[14] = 200 / 260; U[15] = 1; U[O_MISC + 2] = 0;
  plane(U, 0, 1, 0, 0, 0, 0, 0, 512); plane(U, 1, -1, 0, 0, 0, 0, 0, 512); plane(U, 2, 0, 0, 1, 0, 0, 0, 512); plane(U, 3, 0, 0, -1, 0, 0, 0, 512);
  const tT = tex(TOPPX, TOPPX, CASC ? DEPTH : D16, RT); await castInto(tT, pSh32 || pSh16, 512, [1, 0, 0], [0, 0, -1]);
  const lT = layout('d', SS.FRAGMENT), mT = mod(W_FS + /*wgsl*/`@group(0) @binding(0) var t: texture_depth_2d; @fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f { return vec4f(200. - 260. * textureLoad(t, vec2i(fc.xy), 0), 0., 0., 1.); }`, 'top');
  const e = device.createCommandEncoder(), r = e.beginRenderPass({ colorAttachments: [colorAtt(mipView(tTop, 0), true)] }); r.setPipeline(fsPipe(mT, lT, 'r16float')); r.setBindGroup(0, group(lT, [tT])); r.draw(3); r.end(); genMips(e, tTop);
  Q.submit([e.finish()]);
  tT.destroy();
  U[O_MISC + 2] = 1; U[O_MISC + 3] = 1; U[O_LODB] = 0;
}
const passShadow = depthPass(tSh[0]);

// full-screen passes
// passes a level leaves out are never compiled
const lLight = layout('usscttt' + 'dttkk' + 'dddd' + 'tttt', SS.FRAGMENT), lAO = layout('udtt', SS.FRAGMENT), lTAA = layout('ustt' + 'd', SS.FRAGMENT), lPost = layout('ustt', SS.FRAGMENT);
const pLight = fsPipe(mod(W_LIGHT, 'light'), lLight, HDR), pAO = SSAO && fsPipe(mod(W_AO, 'ao'), lAO, 'rg16float'), pTAA = fsPipe(mod(W_TAA, 'taa'), lTAA, HDR), pPost = fsPipe(mod(W_POST, 'post'), lPost, FMT);
// history stretched into a new resolution
const pFit = device.createRenderPipeline({ layout: plOf(lBlit), vertex: { module: mBlit, entryPoint: 'vsFit' }, fragment: { module: mBlit, entryPoint: 'fsFit', targets: [{ format: HDR }] } });
const tWhite = tex(1, 1, 'rg16float', RT | TU.COPY_DST);
Q.writeTexture({ texture: tWhite }, new Uint16Array([0x3c00, 0x3c00]), {}, [1, 1]);

// timing (GPU timestamp queries, one pair per stage)
// PASSES was reindexed when the mirror view, god rays and polished-stone SSR were deleted: gbuffer 4->3, ao 5->4,
// light 6->5, transp 7->6 (now the water pass alone), taa 8->7, bloom 9->8, post 10->9
const PASSES = ['waves', 'cull', 'shadow', 'gbuffer', 'ao', 'light', 'transp', 'taa', 'bloom', 'post'], NP = PASSES.length;
const gpuMs = new Float64Array(NP + 1); // per stage, then the whole frame
let qs = null, qResolve = null; const qRead = [];
if (hasTS) {
  qs = device.createQuerySet({ type: 'timestamp', count: NP * 2 });
  qResolve = device.createBuffer({ size: NP * 16, usage: BU.QUERY_RESOLVE | BU.COPY_SRC });
  for (let i = 0; i < 6; i++) {
    const b = device.createBuffer({ size: NP * 16, usage: BU.MAP_READ | BU.COPY_DST }), o = { b, busy: false, done: null };
    o.done = () => {
      // ns timestamps as pairs of 32-bit words (BigInt would allocate every frame)
      const a = new Uint32Array(b.getMappedRange()), T = (i) => a[i * 2 + 1] * 4294967296 + a[i * 2];
      for (let k = 0; k < NP; k++) gpuMs[k] = (T(k * 2 + 1) - T(k * 2)) / 1e6;
      const t = (T(NP * 2 - 1) - T(0)) / 1e6; if (t > 0 && t < 1e3) { gpuMs[NP] = t; gpuN++; dynG += t; dynGN++; }
      b.unmap(); o.busy = false;
    };
    qRead.push(o);
  }
}
let gpuN = 0, tsOn = false; // read back only while shown (stats overlay, benchmark)
// timestamp writes for the first / last / only pass of stage k
const tsB = (k) => (hasTS ? { querySet: qs, beginningOfPassWriteIndex: k * 2 } : undefined), tsE = (k) => (hasTS ? { querySet: qs, endOfPassWriteIndex: k * 2 + 1 } : undefined);
const tsBE = (k) => (hasTS ? { querySet: qs, beginningOfPassWriteIndex: k * 2, endOfPassWriteIndex: k * 2 + 1 } : undefined);
const passWaves = [0, 1, 2, 3, 4, 5].map((m) => ({ colorAttachments: [colorAtt(mipView(tWater, m), true)], timestampWrites: m === 0 ? tsB(0) : m === 5 ? tsE(0) : undefined }));
const passCull = { timestampWrites: tsBE(1) };
passShadow.timestampWrites = tsBE(2);

// render targets (rebuilt on resize)
// drawn at up to `pix` pixels and stretched over the window; frame() adapts pix to hold 60 fps, starting where
// the last visit left it. PIXTOP: a level's maximum.
let W = 0, H = 0, DW = 0, DH = 0, targets = [], hist = null;
let passG, passAO, passLight, passWater, passTAA = [], passPost, bloomPass = [], bloomBG = [];
let bgLight, bgAO, bgFx, bgTAA = [], bgPost = [], cpA, cpB, cpD, cpDc, cpSize;
// one bind-group set per profile (0 day, 1 night); the toggle swaps the set, resize rebuilds both. The lets above
// hold the ACTIVE profile's groups, assigned here and by setNight.
const lightSets = [{}, {}];
const NB = NBLOOM, FIXW = +QP.get('w') || 0, FIXH = +QP.get('h') || 0;
const PIXTOP = QL(1e9, 2560 * 1440, 1280 * 720), PIXMIN = mob ? 25e4 : 4e5;
let pix = +QP.get('pix') || (FIXW ? 1e9 : +SV[1] || (mob && LV > 1 ? 41e4 : 1e9));
// what frame() measures between decisions
let dynN = 0, dynT = 0, dynMax = 0, dynG = 0, dynGN = 0, dynBad = 0, dynOk = 0, dynWait = 3, dynOn = false;
// ?slow=N draws every frame N times (simulates a slower GPU)
const DYN = !FIXW || QP.has('dyn'), SLOW = max(1, +QP.get('slow') | 0);
function resize() {
  DW = FIXW || max(2, round(canvas.clientWidth * devicePixelRatio)); DH = FIXH || max(2, round(canvas.clientHeight * devicePixelRatio));
  const sc = min(1, sqrt(min(pix, PIXTOP) / (DW * DH))), w = max(2, round(DW * sc) & ~1), h = max(2, round(DH * sc) & ~1);
  if (w === W && h === H) return;
  // the last frame's history survives briefly, to be stretched into the new one
  const old = hist && hist[(F[FRAME] + 1) & 1];
  W = w; H = h; canvas.width = W; canvas.height = H;
  ctx.configure({ device, format: FMT, alphaMode: 'opaque' });
  for (const t of targets) if (t !== old) t.destroy(); targets = [];
  const T = (w, h, f, u = RT) => { const t = tex(w, h, f, u); targets.push(t); return t; };
  const gset = (w, h) => [T(w, h, 'rgba8unorm'), T(w, h, HDR), T(w, h, 'rgba8unorm'), T(w, h, DEPTH, RT | TU.COPY_SRC)];
  const g = gset(W, H);
  const tA = T(W, H, HDR, RT | TU.COPY_SRC), tB = T(W, H, HDR, TU.TEXTURE_BINDING | TU.COPY_DST), tDc = T(W, H, DEPTH, TU.TEXTURE_BINDING | TU.COPY_DST);
  const tAO = SSAO ? T(W >> 1, H >> 1, 'rg16float') : tWhite; hist = [T(W, H, HDR), T(W, H, HDR)];
  const gPass = (g, ts) => ({ colorAttachments: [colorAtt(g[0].createView(), true), colorAtt(g[1].createView(), true), colorAtt(g[2].createView(), true)],
    depthStencilAttachment: { view: g[3].createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' }, timestampWrites: ts });
  const cPass = (c, d, ts) => ({ colorAttachments: [colorAtt(c.createView(), false)], depthStencilAttachment: { view: d.createView(), depthLoadOp: 'load', depthStoreOp: 'store' }, timestampWrites: ts });
  passG = gPass(g, tsBE(3));
  if (SSAO) { passAO = { colorAttachments: [colorAtt(tAO.createView(), true)], timestampWrites: tsBE(4) }; bgAO = group(lAO, [ubo[V_MAIN], g[3], g[1], g[2]]); }
  passLight = { colorAttachments: [colorAtt(tA.createView(), true)], timestampWrites: tsBE(5) };
  passWater = cPass(tA, g[3], tsBE(6));
  // lighting groups for both profiles: they differ only in the baked sky/env/shadow textures
  for (const n of [0, 1]) {
    const P = n ? { sky: tSkyN, env: cvEnvN, irr: cvIrrN, s1: tShN[1], s2: tShN[2], s3: tShN[3] } : { sky: tSky, env: cvEnv, irr: cvIrr, s1: tSh[1], s2: tSh[2], s3: tSh[3] };
    const lightBG = (u, gg, ao) => group(lLight, [u, sLin, sRep, sCmp, gg[0], gg[1], gg[2], gg[3], ao, P.sky, P.env, P.irr, tSh[0], P.s1, P.s2, P.s3, tWater, tNoiseA, tTop, tWhite]);
    const fxBG = (sc, d) => group(lFx, [sc, d, P.sky, P.env, tSh[0], P.s1, P.s2, P.s3, tWater, sCmp]);
    const S = lightSets[n];
    S.bgLight = lightBG(ubo[V_MAIN], g, tAO);
    S.bgFx = fxBG(tB, tDc);
  }
  ({ bgLight, bgFx } = lightSets[night]);
  passTAA = [0, 1].map((i) => ({ colorAttachments: [colorAtt(hist[i].createView(), true)], timestampWrites: tsBE(7) }));
  bgTAA = [0, 1].map((i) => group(lTAA, [ubo[V_MAIN], sLin, tA, hist[1 - i], g[3]]));
  const bl = []; for (let i = 0; i < NB; i++) bl.push(T(max(1, W >> (i + 1)), max(1, H >> (i + 1)), HDR));
  // bloom: down hist -> b0 .. b5, then up additively to b0; one chain per history buffer
  bloomPass = []; bloomBG = [[], []];
  for (let i = 0; i < NB; i++) { bloomPass.push({ colorAttachments: [colorAtt(bl[i].createView(), true)], timestampWrites: i === 0 ? tsB(8) : undefined }); for (const k of [0, 1]) bloomBG[k].push(blitBG(i ? bl[i - 1].createView() : hist[k].createView())); }
  for (let i = NB - 1; i > 0; i--) { bloomPass.push({ colorAttachments: [colorAtt(bl[i - 1].createView(), false)], timestampWrites: i === 1 ? tsE(8) : undefined }); for (const k of [0, 1]) bloomBG[k].push(blitBG(bl[i].createView())); }
  passPost = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }], timestampWrites: tsBE(9) };
  bgPost = [0, 1].map((i) => group(lPost, [ubo[V_MAIN], sLin, hist[i], bl[0]]));
  cpA = { texture: tA }; cpB = { texture: tB }; cpD = { texture: g[3] }; cpDc = { texture: tDc }; cpSize = [W, H];  // start a new size from the old picture: with no history every resolution change would flash
  if (old) {
    const e = device.createCommandEncoder(), bg = blitBG(old.createView());
    for (const t of hist) { const r = e.beginRenderPass({ colorAttachments: [colorAtt(t.createView(), true)] }); r.setPipeline(pFit); r.setBindGroup(0, bg); r.draw(3); r.end(); }
    Q.submit([e.finish()]); old.destroy();
  } else F[RESET] = 1;
  dynN = dynG = dynGN = dynMax = 0; dynT = -300; // let the new size settle before measuring
}

// camera state
// per-frame numbers in one preallocated array: the frame loop allocates nothing
const F = new Float64Array(16), P6 = new Float64Array(6);
const CX = 0, CY = 1, CZ = 2, YAW = 3, PIT = 4, VX = 5, VY = 6, VZ = 7, TIME = 8, FLT = 9, LAST = 10, HUDT = 11, SPL = 12, RESET = 13, FRAME = 14, DT = 15;
function aim() {
  const dx = P6[3] - P6[0], dy = P6[4] - P6[1], dz = P6[5] - P6[2];
  F[CX] = P6[0]; F[CY] = P6[1]; F[CZ] = P6[2]; F[YAW] = atan2(dx, -dz); F[PIT] = atan2(dy, sqrt(dx * dx + dz * dz));
}
const lookAt = (x, y, z, tx, ty, tz) => { P6[0] = x; P6[1] = y; P6[2] = z; P6[3] = tx; P6[4] = ty; P6[5] = tz; aim(); F[RESET] = 1; };
// Catmull-Rom over position + look-at at F[SPL]; the pack's fly runs 2.5 s per point (docs/mpk-format.md)
const FLYN = FLY.length / 6, FLYT = PK.h.fly ? (PK.h.fly.length / 6 - 1) * 2.5 : 60;
function flyRaw() {
  const s = F[SPL]; let i = floor(s) | 0; if (i > FLYN - 2) i = FLYN - 2;
  const u = s - i, i0 = (i > 0 ? i - 1 : 0) * 6, i1 = i * 6, i2 = (i + 1) * 6, i3 = (i + 2 < FLYN ? i + 2 : FLYN - 1) * 6;
  for (let o = 0; o < 6; o++) { const a = FLY[i0 + o], b = FLY[i1 + o], c = FLY[i2 + o], d = FLY[i3 + o]; P6[o] = 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (3 * b - a - 3 * c + d) * u * u * u); }
  aim();
}
// camera on the path at F[FLT] (control points evenly spaced in time)
function flyAt() { let s = F[FLT] / FLYT; s = s < 0 ? 0 : s > 1 ? 1 : s; F[SPL] = s * (FLYN - 1); flyRaw(); }
// GPS follow camera: 8 m behind the vehicle, 4 m up, looking 25 m ahead along its travel yaw —
// navigation framing, eased over the same F fields free flight uses (no camera system of its own)
const follow = (dt) => {
  if (!VEHICLE.got) return; // live source with no fix yet: keep flying free
  const v = VEHICLE, x = v.edge >= 0 ? v.sx : v.x, z = v.edge >= 0 ? v.sz : v.z, k = 1 - exp(-dt * 4);
  F[CX] += (x - sin(v.yaw) * 8 - F[CX]) * k; F[CY] += (v.y + 4 - F[CY]) * k; F[CZ] += (z + cos(v.yaw) * 8 - F[CZ]) * k;
  const tx = x + sin(v.yaw) * 25, tz = z - cos(v.yaw) * 25;
  F[YAW] += angd(atan2(tx - F[CX], -(tz - F[CZ])), F[YAW]) * k;
  F[PIT] += (atan2(v.y - F[CY], hypot(tx - F[CX], tz - F[CZ])) - F[PIT]) * k;
  F[VX] = F[VY] = F[VZ] = 0;
};
resize();
addEventListener('resize', resize);

// day/night toggle: swap the baked textures' bind groups and the per-view sun/exposure/night uniforms, both
// preallocated. The first switch to a profile bakes its shadow maps once with that profile's sun (frames idle for
// it, about a second on High); after that switching is instant.
let rebake = false; // a shadow bake is running: frame() idles (UB[V_SH] and the map contents are being rewritten)
let dnB = null; // the drawer's Day/Night buttons (wired in the UI section below)
const setNight = async (n) => {
  n = n ? 1 : 0; if (n === night) return;
  night = n;
  ACTIVE_SUN = n ? NIGHT_SUN : SUN; LR = vnorm([ACTIVE_SUN[2], 0, -ACTIVE_SUN[0]]); LU = vcross(ACTIVE_SUN, LR);
  for (const U of UB) setViewSun(U, n);
  if (!shReady[n]) {
    rebake = true;
    const t0 = performance.now();
    await bakeShadowMaps(n ? tShN : tSh); shReady[n] = true;
    if (QP.has('log')) console.log(`shadow rebake (${n ? 'night' : 'day'} sun) ${((performance.now() - t0) / 1000).toFixed(2)} s`);
    rebake = false;
  }
  shadowMat(O_SM + 16, 0, 0, 0, 480, -900, 900, SHN[1], true);
  shadowMat(O_SM + 32, 0, 0, 0, 1400, -2600, 2600, SHN[2], true);
  shadowMat(O_SM + 48, 0, 0, 0, 6800, -9000, 9000, SHN[3], true);
  ({ bgLight, bgFx } = lightSets[n]);
  F[RESET] = 1; // the TAA history is from the other profile
  if (!AUTO) { try { localStorage.atlasNight = n ? '1' : '0'; } catch {} }
  if (dnB) { dnB[0].className = n ? '' : 'on'; dnB[1].className = n ? 'on' : ''; }
  const nt = $('nt'); if (nt) { nt.textContent = n ? '☀' : '🌙'; nt.title = n ? 'Day (N)' : 'Night (N)'; } // the stack glyph mirrors the profile
  if (AUTO) console.log(`profile: ${n ? 'night' : 'day'} · sun ${ACTIVE_SUN.map((v) => v.toFixed(2))} · sunc ${(n ? SUNCN : SUNC).map((v) => v.toFixed(3))} · expo ${n ? EXPO_N : EXPO}`);
};
window.__night = (n) => setNight(n === undefined ? 1 - night : n); // headless tests / console
window.__dbg = () => ({ dead, rebake, hud, night, hidden: document.hidden, lv: LV }); // visual probes: why the frame loop idles

// frame
const JIT = new Float32Array(32); // Halton (2, 3) sub-pixel offsets
for (let i = 0; i < 16; i++) { const h = (n, b) => { let f = 1, r = 0; while (n > 0) { f /= b; r += f * (n % b); n = floor(n / b); } return r; }; JIT[i * 2] = h(i + 1, 2) - 0.5; JIT[i * 2 + 1] = h(i + 1, 3) - 0.5; }
const PVP = new Float32Array(16), submitList = [null];
let hud = false;
function render() {
  const U = UB[V_MAIN], S = UB[V_SH], fr = F[FRAME], t = F[TIME], par = fr & 1;
  const cx = F[CX], cy = F[CY], cz = F[CZ], j = (fr & 15) * 2;
  // unjittered first: that matrix is next frame's reprojection target
  setCam(U, cx, cy, cz, F[YAW], F[PIT], W, H, 0, 0);
  for (let i = 0; i < 16; i++) { U[32 + i] = PVP[i]; PVP[i] = U[i]; }
  setCam(U, cx, cy, cz, F[YAW], F[PIT], W, H, JIT[j] * 2 / W, JIT[j + 1] * 2 / H);
  U[O_CAM + 3] = t; U[O_JIT + 2] = fr;
  U[O_MISC] = F[RESET]; U[O_MISC + 1] = 0; U[O_MISC + 2] = LODK; U[O_MISC + 3] = 1; U[O_LODC] = cx; U[O_LODC + 1] = cy; U[O_LODC + 2] = cz; U[O_LODC + 3] = 1 / LODK;
  if (CASC) {
    // cascade: a 92 m box around the point 36 m ahead of the camera, snapped to its own texel
    // grid — an unsnapped sliding box re-rasterizes the shadow map every frame and the shadow
    // edges crawl as the camera drifts
    const ts = 92 / CASC, ax = cx + U[O_FWD] * 36, az = cz + U[O_FWD + 2] * 36;
    shadowMat(O_SM, Math.round(ax / ts) * ts, cy + U[O_FWD + 1] * 36, Math.round(az / ts) * ts, 46, -420, 700, CASC, true);
    // casters switch LODs only a little sooner, or shadows pop on their own
    S[O_CAM + 3] = t; S[O_MISC + 1] = 2; S[O_MISC + 2] = 1.85 * LODK; S[O_MISC + 3] = 1; S[O_LODC] = cx; S[O_LODC + 1] = cy; S[O_LODC + 2] = cz;
    Q.writeBuffer(ubo[V_SH], 0, S);
  }
  Q.writeBuffer(ubo[V_MAIN], 0, U);
  WT[0] = t; Q.writeBuffer(uboW, 0, WT);

  const e = device.createCommandEncoder();
  let slot = null;
  // GPU timings: while shown, and every 8th frame while tuning resolution
  if (tsOn || (dynOn && (fr & 7) === 0)) for (let i = 0; i < qRead.length; i++) if (!qRead[i].busy) { slot = qRead[i]; break; }
  let r = e.beginRenderPass(passWaves[0]); r.setPipeline(pWaves); r.setBindGroup(0, bgWaves); r.draw(3); r.end();
  for (let i = 1; i < 6; i++) { r = e.beginRenderPass(passWaves[i]); r.setPipeline(pMip[HDR]); r.setBindGroup(0, waterBG[i - 1]); r.draw(3); r.end(); }
  // visibility and LOD for the two views
  const c = e.beginComputePass(passCull); cullView(c, V_MAIN); if (CASC) cullView(c, V_SH); c.end();
  if (CASC) {
    r = e.beginRenderPass(passShadow); r.setBindGroup(0, bgScene[V_SH]); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32');
    r.setPipeline(pSh32); drawList(r, V_SH, LS[K.SOLID].near); r.end();
  }
  // main view G-buffer: buildings first, the ground they hide last
  r = e.beginRenderPass(passG); r.setBindGroup(0, bgScene[V_MAIN]); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32');
  r.setPipeline(pG); drawList(r, V_MAIN, LS[K.SOLID].all);
  r.setPipeline(pG); drawList(r, V_MAIN, LS[K.SOLID].gnd);
  if (windows) { r.setPipeline(pG); drawList(r, V_MAIN, LS[K.GLASS].all); } // off by default
  r.end();
  if (SSAO) { r = e.beginRenderPass(passAO); r.setPipeline(pAO); r.setBindGroup(0, bgAO); r.draw(3); r.end(); }
  r = e.beginRenderPass(passLight); r.setPipeline(pLight); r.setBindGroup(0, bgLight); r.draw(3); r.end();
  // water refracts and reflects the lit scene: it reads copies of the picture and depth so far
  e.copyTextureToTexture(cpA, cpB, cpSize); e.copyTextureToTexture(cpD, cpDc, cpSize);
  r = e.beginRenderPass(passWater); r.setBindGroup(0, bgScene[V_MAIN]); r.setBindGroup(1, bgFx); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32');
  r.setPipeline(pWater); drawList(r, V_MAIN, LS[K.WATER].all); r.end();
  // TAA into this frame's history, bloom from it, then tone mapping
  r = e.beginRenderPass(passTAA[par]); r.setPipeline(pTAA); r.setBindGroup(0, bgTAA[par]); r.draw(3); r.end();
  for (let i = 0; i < bloomPass.length; i++) { r = e.beginRenderPass(bloomPass[i]); r.setPipeline(i === 0 ? (night ? pDown0N : pDown0) : i < NB ? pDown : pUp); r.setBindGroup(0, bloomBG[par][i]); r.draw(3); r.end(); }
  passPost.colorAttachments[0].view = ctx.getCurrentTexture().createView();
  r = e.beginRenderPass(passPost); r.setPipeline(pPost); r.setBindGroup(0, bgPost[par]); r.draw(3); r.end();
  if (slot) { e.resolveQuerySet(qs, 0, NP * 2, qResolve, 0); e.copyBufferToBuffer(qResolve, 0, slot.b, 0, NP * 16); }
  submitList[0] = e.finish(); Q.submit(submitList);
  if (slot) { slot.busy = true; slot.b.mapAsync(GPUMapMode.READ).then(slot.done); }
  updateLabels(U);
  F[FRAME] = fr + 1; F[RESET] = 0;
}

// screen-space label overlay: one div per visible label from a fixed pool. Projection reuses the
// main view matrix (same layout as the vertex shader), the placement uses the shared collision
// grid; no geometry rebuild and no per-frame allocation beyond the short candidate list.
const LAB_LAYER = $('labs'), LAB_POOL = [];
let labTick = 0, labState = [];
window.__labelState = () => labState.slice(); // dev.js __shot composites these into stills
const updateLabels = (U) => {
  if (!LAB_LAYER) return;
  if ((labTick++ & 3) !== 0 && labState.length) return; // every 4th frame is plenty
  const w = innerWidth, h = innerHeight, cx = U[O_CAM], cy = U[O_CAM + 1], cz = U[O_CAM + 2];
  const cand = [];
  for (const e of Wd.labels) {
    if (!(e.kind ? showStreet : showNum)) continue;
    const dx = e.x - cx, dy = e.y - cy, dz = e.z - cz, d2 = dx * dx + dy * dy + dz * dz;
    const far = e.kind ? 300 : 220;
    if (d2 > far * far) continue;
    cand.push({ ...e, dist: Math.sqrt(d2) });
  }
  const chosen = place(cand, (e) => {
    const cw = U[0] * e.x + U[4] * e.y + U[8] * e.z + U[12];
    const cwy = U[1] * e.x + U[5] * e.y + U[9] * e.z + U[13];
    const cww = U[3] * e.x + U[7] * e.y + U[11] * e.z + U[15];
    if (cww <= 1) return null;
    return [(cw / cww * 0.5 + 0.5) * w, (0.5 - cwy / cww * 0.5) * h, e.dist];
  }, { W: w, H: h, max: 110, cellW: 66, cellH: 26, pad: 3, quota: { 1: 34 }, widthOf: (t) => t.length * 6.6 + 14 });
  labState = chosen.map((e) => ({ text: e.text, x: e.sx, y: e.sy, kind: e.kind }));
  for (let i = 0; i < chosen.length; i++) {
    let d = LAB_POOL[i];
    if (!d) { d = document.createElement('div'); LAB_LAYER.appendChild(d); LAB_POOL[i] = d; }
    const e = chosen[i];
    if (d.textContent !== e.text) d.textContent = e.text;
    const cls = e.kind ? 'lab street' : 'lab num';
    if (d.className !== cls) d.className = cls;
    d.style.display = '';
    d.style.transform = `translate(${e.sx.toFixed(1)}px,${e.sy.toFixed(1)}px) translate(-50%,-50%)`;
  }
  for (let i = chosen.length; i < LAB_POOL.length; i++) if (LAB_POOL[i].style.display !== 'none') LAB_POOL[i].style.display = 'none';
};

const render0 = render; // dev.js wraps `render`
let kf = 0, kb = 0, kl = 0, kr = 0, ku = 0, kd = 0, ks = 0, mdx = 0, mdy = 0, lkx = 0, lky = 0, l2x = 0, l2y = 0, hN = 0, hMax = 0, menu = false; // menu: input suppressed while the drawer is open (dev.js also sets it)
let solid = !QP.has('noclip'); // key C
let tId = -1, tN = 0, tx = 0, ty = 0, tx0 = 0, ty0 = 0; // touch: steering finger id, fingers down, its position and where it went down
// flying speed: wheel scales it ~15% a step (0.25-50 m/s, Shift x8 too); middle button resets to 12.5 m/s
let spd = clamp(+QP.get('spd') || 1, 0.02, 4);
addEventListener('wheel', (e) => { if (!menu) spd = clamp(spd * exp(-(e.deltaMode ? e.deltaY * 33 : e.deltaY) * 0.0014), 0.02, 4); }, { passive: true });
addEventListener('mousedown', (e) => { if (!menu && e.button === 1) { e.preventDefault(); spd = 1; } });
const FPS = +QP.get('fps') || 0; // optional fps cap (development)
// dynamic resolution, decided every second (0.4 s while the drawer is open). Nothing runs or allocates on a machine that
// keeps up at full resolution.
function tune() {
  const top = min(PIXTOP, DW * DH), was = pix > top ? top : pix;
  // the one longest frame is left out: a single hitch changes nothing
  const a = dynN > 1 ? (dynT - dynMax) / (dynN - 1) : dynT, g = dynGN ? dynG / dynGN * SLOW : 0;
  let k = 1;
  // with GPU time keep it in 9.8-13.6 ms; otherwise (or if frames are late anyway) frame intervals decide
  if (g > 13.6) k = 11.7 / g;
  // slow twice in a row: fewer pixels, and wait twice as long to go back up
  else if (a > 17.6) { dynOk = 0; if (++dynBad > 1) { k = 15 / a; dynBad = 0; dynWait = min(dynWait * 2, 60); } }
  else {
    dynBad = 0;
    if (was < top) { if (g) { if (g < 9.8) k = 11.7 / g; } else if (a < 12.5) k = 15 / a; else if (++dynOk > dynWait) { k = 1.17; dynOk = 0; } } // at the display's rate room is unknown: try a little more now and then
  }
  k = k < 0.5 ? 0.5 : k > 1.7 ? 1.7 : k; if (k > 0.96 && k < 1.04) k = 1;
  let to = was * k; to = to < PIXMIN ? min(PIXMIN, top) : to > top ? top : to;
  pix = to < top ? to : 1e9; // no limit at full resolution, so a larger window is followed
  dynOn = hasTS && (to < top || a > 17.6);
  dynN = dynT = dynMax = dynG = dynGN = 0;
  if (to !== was) { keep('atlas', [LV, to < top ? to | 0 : '']); resize(); }
}
function frame(now) {
  requestAnimationFrame(frame);
  if (dead || document.hidden || rebake) return; // rebake: frames idle while the other profile's shadow maps bake
  const dtr = now - F[LAST];
  if (FPS && dtr < 1000 / FPS - 1) return;
  F[LAST] = now;
  let dt = dtr / 1000; if (dt > 0.1) dt = 0.1;
  if (DYN && !FPS && dtr < 1e3 && (dynT += dtr) > 0) { dynN++; if (dtr > dynMax) dynMax = dtr; if (dynT > (menu ? 400 : 1000)) tune(); }
  F[TIME] += dt; F[DT] = dt;
  // touch: the finger's offset from where it went down steers like a joystick
  if (tId >= 0) {
    const tr = 4 / min(innerWidth, innerHeight); let jx = (tx - tx0) * tr, jy = (ty - ty0) * tr;
    jx = jx > 1 ? 1 : jx < -1 ? -1 : jx; jy = jy > 1 ? 1 : jy < -1 ? -1 : jy;
    lkx += jx * 1.5 * dt; lky += jy * dt;
  }
  // mouse look through two cascaded low-pass stages; velocity eases towards the keys
  const kq = 1 - exp(-dt * 30); lkx += mdx * 0.0022; lky += mdy * 0.0022; mdx = 0; mdy = 0;
  const ax = lkx * kq, ay = lky * kq; lkx -= ax; lky -= ay; l2x += ax; l2y += ay;
  const dyw = l2x * kq, dpt = l2y * kq; l2x -= dyw; l2y -= dpt;
  const yaw = F[YAW] + dyw; let pitch = F[PIT] - dpt; pitch = pitch < -1.55 ? -1.55 : pitch > 1.55 ? 1.55 : pitch;
  // one finger flies forward, a second flies fast
  const sp = (ks || tN > 1 ? 100 : 12.5) * spd, k = 1 - exp(-dt * 5), mf = kf - kb + (tN > 0 ? 1 : 0), mr = kr - kl, mu = ku - kd, cp = cos(pitch), sy = sin(yaw), cw = cos(yaw);
  const vx = F[VX] + ((sy * cp * mf + cw * mr) * sp - F[VX]) * k, vy = F[VY] + ((sin(pitch) * mf + mu) * sp - F[VY]) * k, vz = F[VZ] + ((-cw * cp * mf + sy * mr) * sp - F[VZ]) * k;
  let x = F[CX] + vx * dt, y = F[CY] + vy * dt, z = F[CZ] + vz * dt;
  const rad = sqrt(x * x + z * z); if (rad > 6000) { x *= 6000 / rad; z *= 6000 / rad; }
  y = y < 0.6 ? 0.6 : y > 2500 ? 2500 : y;
  const px = F[CX], py = F[CY], pz = F[CZ];
  F[YAW] = yaw; F[PIT] = pitch; F[VX] = vx; F[VY] = vy; F[VZ] = vz; F[CX] = x; F[CY] = y; F[CZ] = z;
  // collision (collide.js); key C disables it
  if (solid) { collide(px, py, pz); x = F[CX]; y = F[CY]; z = F[CZ]; }
  if (gpsOn) { gpsFrame(dt); follow(dt); } // GPS drives: vehicle update, then the follow camera
  for (let i = 1; i < SLOW; i++) render0(); // ?slow: extra frames drawn and discarded
  render();
  if (hud) {
    hN++; if (dtr > hMax) hMax = dtr; F[HUDT] += dtr / 1000;
    if (F[HUDT] > 0.5) { let s = `${(hN / F[HUDT]).toFixed(0)} fps · worst frame ${hMax.toFixed(1)} ms · GPU ${(gpuMs[NP] * SLOW).toFixed(2)} ms · ${W}x${H}${W < DW ? ` (${(100 * W / DW).toFixed(0)}% of ${DW}x${DH})` : ''} · ${LVN[LV]}\n`; for (let i = 0; i < NP; i++) s += `${PASSES[i]} ${gpuMs[i].toFixed(2)}  `; info.textContent = s + `\n${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)} · yaw ${(((yaw / DEG) % 360 + 360) % 360).toFixed(0)}° pitch ${(pitch / DEG).toFixed(0)}° · speed ${(12.5 * spd).toFixed(spd < 0.8 ? 2 : 1)} m/s${solid ? '' : ' · collision off (C)'}`; F[HUDT] = 0; hN = 0; hMax = 0; }
  }
}

// input and UI: the scene is live from the start; the settings drawer is the only chrome
const key = (e, v) => {
  switch (e.code) {
    case 'KeyW': kf = v; break; case 'KeyS': kb = v; break; case 'KeyA': kl = v; break; case 'KeyD': kr = v; break;
    case 'KeyE': ku = v; break; case 'KeyQ': kd = v; break; case 'ShiftLeft': case 'ShiftRight': ks = v; break;
    default: if (v && !e.repeat) {
      if (e.code === 'KeyH') setHud(!hud);
      else if (e.code === 'KeyC') { solid = !solid; colUI(); }
      else if (e.code === 'KeyG') gpsToggle();
      else if (e.code === 'KeyN') setNight(1 - night);
      else if (e.code >= 'Digit1' && e.code <= 'Digit6') { const p = POSES[e.code.charCodeAt(5) - 49]; if (p) { lookAt(...p); F[VX] = F[VY] = F[VZ] = 0; } }
    }
  }
};

// stats toggle, from the H key, the 📊 stack button and the drawer row
const setHud = (v) => { hud = v; tsOn = hud && hasTS; info.textContent = ''; const b = $('hs'); if (b) b.className = v ? 'on' : ''; const r = $('hb'); if (r) { r.textContent = v ? 'On' : 'Off'; r.className = v ? 'on' : ''; } };
// collision toggle, from the C key and the drawer row
const colUI = () => { const r = $('cb'); if (r) { r.textContent = solid ? 'On' : 'Off'; r.className = solid ? 'on' : ''; } };
// windows + bays + doors toggle, from the drawer row; gates K.GLASS draws, never rebuilds the world
const winUI = () => { const r = $('wi'); if (r) { r.textContent = windows ? 'On' : 'Off'; r.className = windows ? 'on' : ''; } };
const setWindows = (v) => { windows = v === undefined ? 1 - windows : +!!v; if (!AUTO) { try { localStorage.atlasWin = windows ? '1' : '0'; } catch {} } winUI(); return windows; };
window.__windows = setWindows; // headless probes / tests
// the two label layers toggle independently — both feed the same DOM overlay
const numUI = () => { const r = $('ln'); if (r) { r.textContent = showNum ? 'On' : 'Off'; r.className = showNum ? 'on' : ''; } };
const streetUI = () => { const r = $('ls'); if (r) { r.textContent = showStreet ? 'On' : 'Off'; r.className = showStreet ? 'on' : ''; } };
const setNum = (v) => { showNum = v === undefined ? 1 - showNum : +!!v; if (!AUTO) { try { localStorage.atlasNum = showNum ? '1' : '0'; } catch {} } numUI(); return showNum; };
const setStreet = (v) => { showStreet = v === undefined ? 1 - showStreet : +!!v; if (!AUTO) { try { localStorage.atlasStreet = showStreet ? '1' : '0'; } catch {} } streetUI(); return showStreet; };
window.__numbers = setNum;
window.__streets = setStreet;

// the settings drawer: Esc or ⚙ toggles, a click outside closes it; the scene keeps running behind it
let open = false;
const setDrawer = (o) => {
  if (dead || body.classList.contains('l')) return; // nothing to open during loading or after a failure
  if (o === open) { $('w').classList.toggle('open', o); return; }
  open = o; menu = o; if (o) release();
  $('w').classList.toggle('open', o);
  $('st').className = o ? 'on' : '';
  body.className = o ? 'w' : document.pointerLockElement ? 'p' : '';
};
window.__drawer = (o) => setDrawer(o === undefined ? !open : !!o); // headless tests
window.__cam = (lat, lon, y, yawDeg = 0, pitchDeg = -40) => { // headless visual probes: hover over a geodetic point, look along yaw / pitch; returns the camera state
  const g = geodeticToLocal(lat, lon), w = yawDeg * DEG, p = pitchDeg * DEG;
  const dx = sin(w) * cos(p), dy = sin(p), dz = -cos(w) * cos(p);
  lookAt(g[0], y, g[1], g[0] + dx * 150, y + dy * 150, g[1] + dz * 150);
  F[VX] = F[VY] = F[VZ] = 0;
  return [F[CX], F[CY], F[CZ], F[YAW] / DEG, F[PIT] / DEG];
};
$('st').onclick = () => setDrawer(!open);
$('hs').onclick = () => setHud(!hud);
$('hb').onclick = () => setHud(!hud);
$('cb').onclick = () => { solid = !solid; colUI(); };
if ($('wi')) $('wi').onclick = () => setWindows();
if ($('ln')) $('ln').onclick = () => setNum();
if ($('ls')) $('ls').onclick = () => setStreet();
$('nt').onclick = () => setNight(1 - night);
$('lc').onclick = () => locate();
$('ct').onclick = () => { setDrawer(true); const ci = $('ci'); if (!ci.hidden) ci.scrollIntoView({ block: 'nearest' }); };

// geolocation: one fix with a 4 s budget — the start camera and the locate button share it
let geoWhy = 'no fix'; // why the last request produced nothing (for the decision log)
const geoFix = () => new Promise((res) => {
  if (!navigator.geolocation) { geoWhy = 'no geolocation'; return res(null); }
  navigator.geolocation.getCurrentPosition((p) => res(p.coords), (e) => {
    geoWhy = e.code === 1 ? 'geolocation denied' : e.code === 3 ? 'geolocation timeout' : 'geolocation unavailable';
    res(null);
  }, { timeout: 4000, enableHighAccuracy: true, maximumAge: 30000 });
});
// far outside the pack's bounding box (> 3 km past an edge): the fix is useless for framing the city
const outside = (lat, lon) => {
  const b = PK.h.bbox; if (!b) return false;
  const [lat0, lon0] = PK.h.origin, k = cos(lat0 * DEG) * 111320;
  const dLat = lat < b[0] ? b[0] - lat : lat > b[2] ? lat - b[2] : 0, dLon = lon < b[1] ? b[1] - lon : lon > b[3] ? lon - b[3] : 0;
  return max(dLat * 111320, dLon * k) > 3000;
};
// camera above the point, tilted towards the city centre so the city reads around the user's spot
const camOver = (lat, lon, label) => {
  const g = geodeticToLocal(lat, lon), x = g[0], z = g[1];
  lookAt(x, 350, z, x / 2, 0, z / 2);
  F[VX] = F[VY] = F[VZ] = 0;
  if (QP.has('log')) console.log(`${label}: gps ${lat.toFixed(3)}, ${lon.toFixed(3)}`);
};
const locate = async () => {
  const c = await geoFix();
  if (!c || outside(c.latitude, c.longitude)) { if (QP.has('log')) console.log('locate: no usable fix'); return; }
  camOver(c.latitude, c.longitude, 'locate');
};

addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && !e.repeat) { setDrawer(!open); return; } // captured input never gets here: the browser spends Esc on leaving the lock
  if (!menu || e.code === 'KeyH') key(e, 1);
});
addEventListener('keyup', (e) => key(e, 0));
const release = () => { kf = kb = kl = kr = ku = kd = ks = 0; tId = -1; tN = 0; };
addEventListener('blur', release);
const capture = () => { if (mob) return; const p = canvas.requestPointerLock({ unadjustedMovement: true }); if (p && p.catch) p.catch(() => canvas.requestPointerLock()).catch(() => 0); };
addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { mdx += e.movementX; mdy += e.movementY; } });
// touch: hold to fly forward, slide to steer, second finger fast. Portrait phones show the page rotated
// (template.html), so the touch axes turn too.
const rot = matchMedia('(orientation:portrait) and (pointer:coarse)');
const touch = (e) => {
  e.preventDefault(); if (open) { setDrawer(false); return; } // a tap on the scene closes the drawer
  tN = e.touches.length;
  let f = null, first = false; for (let i = 0; i < tN; i++) if (e.touches[i].identifier === tId) f = e.touches[i];
  if (!f) { tId = -1; if (tN) { f = e.touches[0]; tId = f.identifier; first = true; } }
  if (f) {
    const x = rot.matches ? f.clientY : f.clientX, y = rot.matches ? -f.clientX : f.clientY, s = 1100 / min(innerWidth, innerHeight);
    if (first) { tx0 = x; ty0 = y; } else { mdx += (x - tx) * s; mdy += (y - ty) * s; } // the view follows the finger at once
    tx = x; ty = y;
  }
};
for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(n, touch, { passive: false });

// first click or drag on the scene captures the mouse; losing the lock (Esc) opens the drawer
canvas.addEventListener('click', () => { if (open) setDrawer(false); else capture(); });
document.addEventListener('pointerlockchange', () => {
  if (mob) return;
  if (document.pointerLockElement) { if (!open) body.className = 'p'; }
  else setDrawer(true);
});
// detail buttons: the current level is lit, the others reload with theirs
$('q').querySelectorAll('button').forEach((b, i) => { if (i === 2 - LV) b.className = 'on'; else b.onclick = () => { try { localStorage.atlas = 2 - i; } catch {} location.href = location.href.replace(/[?&]lv=\d/, ''); }; });
// light profile row: the active one lit, clicks toggle like key N
dnB = $('dn').querySelectorAll('button');
dnB[0].onclick = () => setNight(0); dnB[1].onclick = () => setNight(1);
dnB[night ? 1 : 0].className = 'on';
const ntB = $('nt'); ntB.textContent = night ? '☀' : '🌙'; ntB.title = night ? 'Day (N)' : 'Night (N)'; // the stack glyph mirrors the profile
$('gb').onclick = gpsToggle; // the drawer's GPS button toggles like the key
colUI(); winUI(); numUI(); streetUI();

// start camera: above the user's position when geolocation answers within its 4 s budget (a fix far outside
// the pack counts as no fix), else the pack's first viewpoint. Placement only — no follow camera, no marker.
const fix = await geoFix();
if (fix && !outside(fix.latitude, fix.longitude)) camOver(fix.latitude, fix.longitude, 'start camera');
else {
  lookAt(...POSES[0]);
  F[VX] = F[VY] = F[VZ] = 0;
  if (QP.has('log')) console.log(`start camera: centre (${fix ? 'outside pack' : geoWhy})`);
}
// draw the first frames and wait for the GPU (pipelines compile on first use) before revealing
await say('Letting the light in…', 1);
render(); await Q.onSubmittedWorkDone();
setTimeout(() => { keep('atlasLoad', ''); keep('atlasLost', ''); }, 15e3); // the load counts as survived after 15 s
body.className = ''; // live at once: the loading plate fades itself out, no gate in between
if (!AUTO) requestAnimationFrame((t) => { F[LAST] = t; requestAnimationFrame(frame); });
else { window.__ready = true; if (QP.get('gps') === 'sim') gpsAuto(); }
