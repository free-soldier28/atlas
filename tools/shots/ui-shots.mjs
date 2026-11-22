// UI verification for the map-style start: headless Chrome + CDP.
// Checks ?auto&log, the geolocation start camera (Emulation.setGeolocationOverride), ?gps=sim&night=1,
// the settings drawer toggle, and takes tools/shots/ui-{loading,live,drawer}.png.
// E: dev.html's __count tool reports the two views after its trim (needs `node source/build.mjs --dev` first).
// usage: node tools/shots/ui-shots.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = path.join(ROOT, 'tools', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tiny static server: the page fetches packs/manifest.json and city packs over http
const MIME = { '.html': 'text/html', '.json': 'application/json', '.mpk': 'application/octet-stream' };
const srv = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream');
    res.end(await readFileSync(f));
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port, BASE = `http://127.0.0.1:${PORT}`;
console.log(`serving ${ROOT} on ${BASE}`);

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'atlas-ui-'));
const port = 9700 + (Date.now() % 400);
const cp = spawn(CHROME, [`--remote-debugging-port=${port}`, '--headless=new', '--enable-unsafe-webgpu',
  '--use-webgpu-adapter-type=swiftshader', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let ws = null, nid = 0;
const pend = new Map();
let logs = [], errs = [], exceptions = 0;
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++nid;
  pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const onMsg = (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
  if (pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(text);
    // WGSL compile errors surface here through the engine's mod() logger — a hard gate below
    if (m.params.type === 'error') errs.push(text);
  }
  if (m.method === 'Runtime.exceptionThrown') { exceptions++; console.log('EXC', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); }
};

let list = null;
for (let i = 0; i < 40 && !list; i++) { await sleep(250); try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
if (!list) throw new Error('no CDP endpoint');
ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; ws.onmessage = onMsg; });
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
// the engine honours prefers-reduced-motion (transitions off): deterministic DOM state for shots —
// under swiftshader the main thread is too starved to settle animated slides within the waits
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
const evalAsync = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const until = async (expr, ms = 60000, what = expr) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evalJs(expr)) return true; await sleep(250); }
  console.log(`TIMEOUT waiting for ${what}`); return false;
};
const shot = async (file) => {
  for (let i = 0; i < 4; i++) {
    try {
      const r = (await send('Page.captureScreenshot', { format: 'png' })).result;
      writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
      console.log('SHOT', file);
      return;
    } catch (e) { console.log(`SHOT ${file} retry: ${e.message}`); await sleep(1500); }
  }
  throw new Error(`screenshot ${file} failed`);
};
const nav = async (url, grant) => {
  logs = []; errs = []; exceptions = 0;
  await send('Page.navigate', { url });
  await sleep(300);
  if (grant) await send('Browser.grantPermissions', { permissions: ['geolocation'], origin: BASE }).catch(() => {});
};
const state = `JSON.stringify({ ready: window.__ready === true, err: window.__err || null, body: document.body.className,
  gone: ['m','d','r','f','k','h','o'].filter((id) => document.getElementById(id)),
  stack: document.querySelectorAll('#t button').length, drawer: !!document.getElementById('w'), plate: !!document.getElementById('ld'),
  cam: window.__info || '' })`;
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++; };

// A: plain auto run — ready, no error, no menu DOM remnants, stack + drawer + plate present
await nav(`${BASE}/index.html?auto&log`);
const readyA = await until('window.__ready === true', 90000, '__ready');
const a = JSON.parse(await evalJs(state) || '{}');
check('A ready:true err:null', readyA && a.ready && !a.err, JSON.stringify(a));
check('A no menu remnants', Array.isArray(a.gone) && a.gone.length === 0, `still present: ${a.gone}`);
check('A stack(5)/drawer/plate', a.stack === 5 && a.drawer && a.plate);
check('A zero console.error', errs.length === 0, errs.slice(0, 3).join(' | '));
const camA = logs.find((l) => l.includes('start camera'));
console.log('A start camera:', camA || '(none)');
check('A fallback logged', !!camA && camA.includes('centre'), camA);

// B: geolocation override (Kalozha area, inside the Grodno pack) — the start camera must use it
await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'granted' }).catch(() => {});
await send('Browser.grantPermissions', { permissions: ['geolocation'] }).catch(() => {});
await send('Emulation.setGeolocationOverride', { latitude: 53.669, longitude: 23.830, accuracy: 1 });
await nav(`${BASE}/index.html?auto&log&city=grodno`, true);
const readyB = await until('window.__ready === true', 150000, '__ready (grodno)');
const camB = logs.find((l) => l.includes('start camera'));
console.log('B start camera:', camB || '(none)');
check('B ready (grodno pack)', readyB);
check('B start camera uses override', /start camera: gps 53\.669, 23\.830/.test(camB || ''), camB);
check('B zero console.error', errs.length === 0, errs.slice(0, 3).join(' | '));

// C: night + simulator path still works, drawer glyph mirrors night
await nav(`${BASE}/index.html?auto&log&gps=sim&night=1`, true);
const readyC = await until('window.__ready === true', 90000, '__ready');
const nightC = logs.some((l) => l.includes('shadow bake (night sun)')); // ?night=1 bakes with the moon at startup
const ntC = await evalJs(`document.getElementById('nt').textContent`);
const driveC = await until(`(document.getElementById('drive').textContent || '').includes('drive=')`, 15000, '#drive probe');
check('C ready + night profile', readyC && nightC, `ready ${readyC}, night bake log ${nightC}`);
check('C night glyph on stack button', ntC === '☀', JSON.stringify(ntC));
check('C gps sim driving', driveC, await evalJs(`document.getElementById('drive').textContent`));
check('C zero console.error', errs.length === 0, errs.slice(0, 3).join(' | '));

// D: the human path — loading plate, live scene, drawer open/close, screenshots
await nav(`${BASE}/index.html?city=grodno&log`, true);
const sawLoading = await until(`document.body.className === 'l'`, 20000, 'loading state');
await until(`(document.getElementById('cn').textContent || '') !== ''`, 30000, 'city name on the plate');
await shot('ui-loading.png');
const live = await until(`document.body.className === '' && !window.__err`, 150000, 'live state');
await sleep(2500); // overlay fade + a few frames
check('D loading plate seen', sawLoading);
check('D scene live (no gate)', live);
const liveState = JSON.parse(await evalJs(state) || '{}');
check('D stack visible + no remnants', liveState.stack === 5 && liveState.gone.length === 0, JSON.stringify(liveState));
const cnD = await evalJs(`document.getElementById('cn').textContent`);
check('D grodno pack loaded (city switch overrides embedded)', cnD === 'Гродно', JSON.stringify(cnD));
await shot('ui-live.png');
await evalJs(`window.__drawer(true)`);
const opened = await until(`document.getElementById('w').classList.contains('open') && document.body.className === 'w'`, 5000, 'drawer open');
const slid = await evalJs(`document.getElementById('t').getBoundingClientRect().right < innerWidth - 200`);
check('D stack clears the drawer (transform slide)', !!slid, `stack rect = ${await evalJs(`JSON.stringify(document.getElementById('t').getBoundingClientRect())`)}`);
await sleep(700); // let a frame render with the new state
const pv = await evalJs(`document.getElementById('pv').textContent`);
check('D drawer opens via toggle fn', opened);
check('D drawer footer (pack · attribution · version)', /Гродно · © OpenStreetMap contributors · atlas 0\.1/.test(pv || ''), JSON.stringify(pv));
await shot('ui-drawer.png');
await evalJs(`window.__drawer(false)`);
const closed = await until(`!document.getElementById('w').classList.contains('open')`, 5000, 'drawer closed');
check('D drawer closes', closed);
check('D zero console.error', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log('D start camera:', logs.find((l) => l.includes('start camera')) || '(none)');

// E: dev.html tooling — __count reads the cull pass's indirect args for both views (trimmed: main + shadow).
// Against the real city (city=grodno): pose budgets catch culling collapse (baselines: street 0.37M,
// aerial 0.09M, shadow ~0.10M — generous 3-4x headroom).
await nav(`${BASE}/dev.html?auto&log&city=grodno`);
const readyE = await until('window.__ready === true', 150000, '__ready (dev, grodno)');
const cntE = readyE ? await evalAsync(`window.__count()`) : null;
check('E dev ready', readyE);
check('E dev __count rows', !!cntE && /main: /.test(cntE) && /shadow: /.test(cntE) && !/mirror|crystal|cascade|undefined/.test(cntE), JSON.stringify(cntE));
const tris = (s, view) => { const m = new RegExp(`${view}: ([0-9.]+) M tris`).exec(s || ''); return m ? +m[1] : NaN; };
const streetMain = tris(cntE, 'main'), streetShadow = tris(cntE, 'shadow'); // start camera = POSES[0], the street pose
check('E street main ≤ 1.5M tris (start camera = pose 1)', Number.isFinite(streetMain) && streetMain <= 1.5, `${streetMain} M (baseline 0.37M)`);
check('E street shadow ≤ 1M tris', Number.isFinite(streetShadow) && streetShadow <= 1, `${streetShadow} M (baseline ~0.10M)`);
// ?auto starts no rAF loop of its own — reach the aerial pose through dev.js's __shot, which draws frames itself
let cntAerial = null;
if (readyE) {
  await evalAsync(`window.__shot({ pose: 4, frames: 6, dt: 1 / 60, crop: [0, 0, 1, 1] })`);
  cntAerial = await evalAsync(`window.__count()`);
}
const aerialMain = tris(cntAerial, 'main'), aerialShadow = tris(cntAerial, 'shadow');
check('E aerial pose drew a fresh frame', Number.isFinite(aerialMain) && Math.abs(aerialMain - streetMain) > 0.005, `__count stayed at ${streetMain} M`);
check('E aerial main ≤ 0.3M tris', Number.isFinite(aerialMain) && aerialMain <= 0.3, `${aerialMain} M (baseline 0.09M)`);
check('E aerial shadow ≤ 1M tris', Number.isFinite(aerialShadow) && aerialShadow <= 1, `${aerialShadow} M`);
console.log(`E counts: street ${streetMain}M main / ${streetShadow}M shadow · aerial ${aerialMain}M main / ${aerialShadow}M shadow`);
check('E zero console.error', errs.length === 0, errs.slice(0, 3).join(' | '));

cp.kill();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
srv.close();
console.log(fails ? `${fails} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
