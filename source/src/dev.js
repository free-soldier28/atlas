// development tools: dev.html only (npm run build:dev)
// F: fly the scripted 60 s path; B: the same flight as a benchmark; F, B or 1-6 stop a flight
// for tools/shot.mjs (?auto=1): __shot() stills and fly-through frames, __bench() benchmark, __stats() GPU time per stage
{
  const LOGN = 1 << 16, logFrame = new Float32Array(LOGN), logGpu = new Float32Array(LOGN);
  let flying = false, bench = false, nFrame = 0, nGpu = 0, seenGpu = 0, tPrev = 0, finish = null, late = '';
  const stop = () => { flying = bench = false; };
  const st = (a, n) => { const s = Array.from(a.subarray(0, n)).sort((x, y) => x - y); let sum = 0; for (const v of s) sum += v; return `avg ${(sum / n).toFixed(2)}  p99 ${s[min(n - 1, floor(n * 0.99))].toFixed(2)}  max ${s[n - 1].toFixed(2)} ms`; };
  const report = () => {
    const over = Array.from(logFrame.subarray(0, nFrame)).filter((v) => v > 16.7).length;
    const s = `Fly-through ${W}x${H}, ${nFrame} frames in ${FLYT} s (${(nFrame / FLYT).toFixed(1)} fps)\nframe  ${st(logFrame, nFrame)}  ·  frames over 16.7 ms: ${over}${late}  ·  long main-thread tasks: ${longN} (max ${longMax.toFixed(0)} ms)\nGPU  ${nGpu ? st(logGpu, nGpu) : 'timestamp-query unavailable'}`;
    info.textContent = s; if (finish) { finish(s); finish = null; }
  };
  // main-thread tasks over 50 ms during a benchmark: own stalls vs frames the browser delivered late
  let longN = 0, longMax = 0;
  try { new PerformanceObserver((l) => { if (bench) for (const e of l.getEntries()) { longN++; longMax = max(longMax, e.duration); } }).observe({ entryTypes: ['longtask'] }); } catch {}
  const draw = render;
  render = () => {
    if (flying) {
      const now = performance.now(), dtr = now - tPrev; tPrev = now;
      F[FLT] += F[DT]; flyAt(); F[VX] = F[VY] = F[VZ] = 0;
      if (bench && F[FLT] > 0.5) { if (dtr > 16.7) late += ` ${dtr.toFixed(1)} ms at ${F[FLT].toFixed(1)} s;`; if (nFrame < LOGN) logFrame[nFrame++] = dtr; if (gpuN !== seenGpu && nGpu < LOGN) { seenGpu = gpuN; logGpu[nGpu++] = gpuMs[NP]; } }
      if (soak) { if (nSoak++ > 30 && now - soakT0 > 3000 && dtr > soakMs) { performance.mark('stall'); soakLog.push(`${dtr.toFixed(0)} ms at ${((now - soakT0) / 1000).toFixed(1)} s (path ${F[FLT].toFixed(1)} s, camera ${F[CX].toFixed(0)},${F[CY].toFixed(0)},${F[CZ].toFixed(0)})`); } if (F[FLT] >= FLYT) { F[FLT] = 0; F[RESET] = 1; } }
      else if (F[FLT] >= FLYT) { if (bench) report(); stop(); }
    }
    draw();
  };
  // soak (tools/soak.mjs): the flight looped for o.s seconds; frames later than o.ms are listed and performance.mark'ed
  let soak = false, soakMs = 25, soakT0 = 0, nSoak = 0, looping = false; const soakLog = [];
  window.__stalls = () => soakLog.length; window.__stallList = () => soakLog.join('; ');
  // toggle the stats text and the GPU timing readback separately, to tell which causes a stall
  window.__panel = (text, timings) => { hud = !!text; tsOn = !!timings && hasTS; info.textContent = ''; return `text ${hud} · timings ${tsOn}`; };
  window.__soak = (o) => new Promise((res) => {
    soakMs = o.ms || 25; soakLog.length = 0; nSoak = 0; soakT0 = performance.now(); menu = false; hud = false; tsOn = hasTS && !!o.ts;
    flying = soak = true; bench = false; F[FLT] = 0; F[RESET] = 1; tPrev = soakT0;
    if (!looping) { looping = true; requestAnimationFrame((t) => { F[LAST] = t; requestAnimationFrame(frame); }); }
    setTimeout(() => { soak = flying = false; res(`soak ${o.s} s at ${W}x${H}: ${nSoak} frames (${(nSoak / o.s).toFixed(1)} fps), ${soakLog.length} over ${soakMs} ms${soakLog.length ? ': ' + soakLog.join('; ') : ''}`); }, o.s * 1000);
  });
  const start = (b) => { flying = true; bench = b; F[FLT] = 0; F[RESET] = 1; nFrame = nGpu = 0; late = ''; tPrev = performance.now(); if (b) { hud = false; tsOn = hasTS && benchTS; info.textContent = ''; } };
  let benchTS = !QP.has('nots'); // ?nots: benchmark without reading GPU timings back
  addEventListener('keydown', (e) => {
    if (menu || e.repeat) return;
    if (e.code === 'KeyF' || e.code === 'KeyB') { if (flying) stop(); else start(e.code === 'KeyB'); } else if (/Digit[1-6]/.test(e.code)) stop();
  });
  const c2 = document.createElement('canvas');
  // stills composite the DOM label overlay onto the canvas: a WebGPU canvas.toDataURL only carries
  // the rendered frame, but __shot must show what the user sees
  const grab = (crop) => {
    const W = crop ? crop[2] : canvas.width, H = crop ? crop[3] : canvas.height;
    c2.width = W; c2.height = H;
    const g = c2.getContext('2d');
    g.drawImage(canvas, crop ? crop[0] : 0, crop ? crop[1] : 0, W, H, 0, 0, W, H);
    const labs = window.__labelState ? window.__labelState() : [];
    if (labs.length) {
      const kx = W / innerWidth, ky = H / innerHeight, ox = crop ? crop[0] : 0, oy = crop ? crop[1] : 0;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const l of labs) {
        const x = (l.x - ox) * kx, y = (l.y - oy) * ky;
        g.font = `${l.kind ? '600 12px' : '600 11px'} system-ui, sans-serif`;
        const tw = g.measureText(l.text).width + 12, th = l.kind ? 18 : 16;
        g.fillStyle = l.kind ? 'rgba(26,40,52,.79)' : 'rgba(18,22,20,.72)';
        g.beginPath(); g.roundRect(x - tw / 2, y - th / 2, tw, th, 5); g.fill();
        g.fillStyle = l.kind ? '#d9ecff' : '#fff';
        g.fillText(l.text, x, y + 0.5);
      }
    }
    return c2.toDataURL('image/png');
  };
  window.__shot = async (o) => {
    const out = [], dt = o.dt || 1 / 60, n = o.frames || 40;
    if (o.time !== undefined) F[TIME] = o.time;
    if (o.fly !== undefined) {
      // approach along the path so the history matches a real flight
      for (let i = n; i >= 0; i--) { F[FLT] = o.fly - i * dt; flyAt(); F[TIME] += dt; if (i === n) F[RESET] = 1; draw(); if (i && i % 8 === 0) await Q.onSubmittedWorkDone(); }
      out.push(grab(o.crop));
      if (o.pair) { F[FLT] = o.fly + dt; flyAt(); F[TIME] += dt; draw(); out.push(grab(o.crop)); }
    } else {
      if (o.pose !== undefined) lookAt(...POSES[o.pose]); else if (o.cam) lookAt(...o.cam);
      for (let i = 0; i < n; i++) { F[TIME] += dt; draw(); if (i < n - 1 && i % 8 === 7) await Q.onSubmittedWorkDone(); }
      out.push(grab(o.crop));
    }
    await Q.onSubmittedWorkDone();
    return out;
  };
  // temporal stability: the camera creeps along o.move per frame at 180 fps; returns mean green-channel change per pixel,
  // the share changing by > 6 levels (visible shimmer), and a map of them (white = 24+ levels)
  window.__flicker = async (o) => {
    const dt = 1 / 180, mv = o.move || [0.01, 0, 0.004], n = o.frames || 90, N = W * H, acc = new Float32Array(N), K = 10;
    if (o.time !== undefined) F[TIME] = o.time;
    if (o.pose !== undefined) lookAt(...POSES[o.pose]); else lookAt(...o.cam);
    const step = () => { F[CX] += mv[0]; F[CY] += mv[1]; F[CZ] += mv[2]; F[TIME] += dt; draw(); };
    for (let i = 0; i < n; i++) { step(); if (i % 8 === 7) await Q.onSubmittedWorkDone(); }
    c2.width = W; c2.height = H; const g = c2.getContext('2d', { willReadFrequently: true }); let prev = null;
    for (let k = 0; k <= K; k++) { step(); g.drawImage(canvas, 0, 0); const d = g.getImageData(0, 0, W, H).data; if (prev) for (let i = 0; i < N; i++) acc[i] += abs(d[i * 4 + 1] - prev[i * 4 + 1]); prev = d; }
    let sum = 0, hot = 0; const im = g.createImageData(W, H);
    for (let i = 0; i < N; i++) { const a = acc[i] / K; sum += a; if (a > 6) hot++; const v = min(255, a * 10.6); im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
    g.putImageData(im, 0, 0);
    return [`mean ${(sum / N).toFixed(3)}  hot ${(hot / N * 100).toFixed(2)}%`, c2.toDataURL('image/png')];
  };
  // starts after 2 s of ordinary frames, like a session already running
  window.__bench = () => new Promise((res) => { finish = res; menu = false; F[FLT] = 0; flyAt(); requestAnimationFrame((t) => { F[LAST] = t; requestAnimationFrame(frame); }); setTimeout(() => start(true), 2000); });
  // peak speed and turn rate of the path (limits: 80 m/s, 40 deg/s), and its lowest clearance over ground or water
  // (the pack world is flat at y 0 until terrain packs arrive)
  const groundY = () => 0;
  window.__path = () => {
    let vm = 0, wm = 0, px = 0, py = 0, pz = 0, pa = 0, lo = 1e9, lt = 0;
    for (let i = 0; i <= 3600; i++) {
      F[FLT] = i / 60; flyAt(); if (i) { vm = max(vm, hypot(F[CX] - px, F[CY] - py, F[CZ] - pz) * 60); wm = max(wm, abs(angd(F[YAW], pa)) * 60 / DEG); } px = F[CX]; py = F[CY]; pz = F[CZ]; pa = F[YAW];
      const c = py - groundY(px, pz); if (c < lo) { lo = c; lt = i / 60; }
    }
    return `path: peak speed ${vm.toFixed(1)} m/s, peak yaw rate ${wm.toFixed(1)} deg/s, lowest ${lo.toFixed(1)} m above ground or water (at ${lt.toFixed(1)} s)`;
  };
  // per view, what the last frame drew: instances and triangles by kind, and the heaviest (type, LOD) slots,
  // read back from the cull pass's indirect draw arguments
  window.__count = async () => {
    const KN = ['solid', , , , 'water'], out = []; // by the world's kind constants: map packs register solid and water
    for (const [v, name, skip] of [[V_MAIN, 'main', 0], [V_SH, 'shadow', NO_NEAR | NO_SHADOW]]) {
      const rb = device.createBuffer({ size: argData.byteLength, usage: BU.MAP_READ | BU.COPY_DST }), e = device.createCommandEncoder();
      e.copyBufferToBuffer(bArgs[v], 0, rb, 0, argData.byteLength); Q.submit([e.finish()]); await rb.mapAsync(GPUMapMode.READ);
      const a = new Uint32Array(rb.getMappedRange()), by = {}, top = []; let tot = 0;
      slots.forEach((s, i) => { if (s.flags & skip || (v === V_SH && s.kind !== K.SOLID)) return; const n = a[i * 5 + 1], t = n * s.mesh.ni / 3, k = KN[s.kind]; by[k] = by[k] || [0, 0]; by[k][0] += n; by[k][1] += t; tot += t; if (n) top.push([t, `${n}x${s.mesh.ni / 3}(${k[0]}${s.lod})`]); });
      top.sort((p, q) => q[0] - p[0]);
      out.push(`${name}: ${(tot / 1e6).toFixed(2)} M tris · ` + Object.entries(by).map(([k, c]) => `${k} ${c[0]} inst ${(c[1] / 1e6).toFixed(2)} M`).join(' · ') + '\n   top: ' + top.slice(0, +QP.get('top') || 9).map((t) => t[1]).join('  '));
      rb.unmap(); rb.destroy();
    }
    return out.join('\n');
  };
  // collision tests. __surf("x,z,y;..."): floor and ceiling there (y decides on or under a bridge).
  // __ram("x,y,z,dx,dy,dz,speed,seconds;..."): push the camera at 180 steps/s; where it ends and the floor there.
  // __hard(): the old Atlantis shape lists are gone — the pack world collides through building boxes instead
  window.__hard = () => 'n/a (pack world: building boxes, see __surf)';
  window.__surf = (s) => s.split(';').map((p) => { const [x, z, y] = p.split(',').map(Number); surfaceAt(x, z, y === undefined ? 1e9 : y); return `floor ${COL[0].toFixed(2)}${COL[1] < 1e8 ? ' ceiling ' + COL[1].toFixed(2) : ''}${COL[2] ? ' natural' : ''}`; }).join(' | ');
  window.__ram = (s) => s.split(';').map((p) => {
    const [x, y, z, dx, dy, dz, sp, secs] = p.split(',').map(Number), l = hypot(dx, dy, dz), n = round(secs * 180), dt = 1 / 180;
    F[CX] = x; F[CY] = y; F[CZ] = z; const t0 = performance.now();
    for (let i = 0; i < n; i++) { const px = F[CX], py = F[CY], pz = F[CZ]; F[VX] = dx / l * sp; F[VY] = dy / l * sp; F[VZ] = dz / l * sp; F[CX] += F[VX] * dt; F[CY] += F[VY] * dt; F[CZ] += F[VZ] * dt; collide(px, py, pz); }
    const us = (performance.now() - t0) * 1000 / n; surfaceAt(F[CX], F[CZ], F[CY]);
    return `-> ${F[CX].toFixed(1)}, ${F[CY].toFixed(2)}, ${F[CZ].toFixed(1)} · moved ${hypot(F[CX] - x, F[CZ] - z).toFixed(1)} m of ${(sp * secs * hypot(dx, dz) / l).toFixed(1)} · floor there ${COL[0].toFixed(2)} · ${us.toFixed(2)} us a step`;
  }).join('\n');
  // land height under "x,z;x,z;...": flat until terrain packs arrive
  window.__ground = () => 'n/a (flat ground)';
  // gps: advance the simulator by ms and report the vehicle state (position, snapped point, edge, speed)
  window.__drive = (ms = 0) => { if (ms > 0) simAdvance(ms); return gpsState(); };
  window.__stats = () => PASSES.map((p, i) => `${p} ${gpuMs[i].toFixed(2)}`).join('  ') + `  | total ${gpuMs[NP].toFixed(2)} ms`;
  if (AUTO) tsOn = hasTS;
  window.__ready = true;
}
