// cornice/parapet probe: the dark band under the roofline. Four azimuths around one flat-roof
// building — the sun sits WNW (golden hour), so sun-facing and anti-sun faces should differ if
// the band is a cast/self shadow rather than a material. usage: node tools/shots/cornice-probe.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = path.join(ROOT, 'tools', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.json': 'application/json', '.mpk': 'application/octet-stream' };
const srv = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(ROOT, p === '/' ? 'dev.html' : p);
    res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream');
    res.end(await readFileSync(f));
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'atlas-cornice-'));
const port = 9800 + (Date.now() % 400);
const cp = spawn(CHROME, ['--window-position=60,60', '--window-size=1320,880', `--remote-debugging-port=${port}`,
  '--enable-unsafe-webgpu', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let nid = 0;
const pend = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++nid;
  pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
let list = null;
for (let i = 0; i < 40 && !list; i++) { await sleep(250); try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
if (!list) throw new Error('no CDP endpoint');
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
  if (pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m); }
};
await send('Runtime.enable');
await send('Page.enable');
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
const evalAsync = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => {
  const s = await evalAsync(`window.__shot({ frames: 30 })`);
  if (!s) { console.log('shot', name, 'null'); return; }
  const data = s[0].split(',')[1];
  writeFileSync(path.join(OUT, `probe-${name}.png`), Buffer.from(data, 'base64'));
  console.log('shot', name, `${(data.length / 1024).toFixed(0)} kB`);
};

await send('Page.navigate', { url: `${BASE}/dev.html?city=grodno&auto&log&lv=1` });
let ready = false;
for (let i = 0; i < 200 && !ready; i++) { await sleep(500); ready = await evalJs('window.__ready === true'); }
if (!ready) throw new Error('engine never became ready');
console.log('ready, __info =', await evalJs('window.__info'));

// a 4-storey panel block in the grid district; orbit it at 30 m distance, roof height.
// __cam hovers at (lat, lon) and LOOKS along yaw — so hover on the far side of the target.
const LAT = 53.66522728042709, LON = 23.775503594418105, M = 9e-6, LM = 1.52e-5; // deg per metre
// orbit the real 16 m panel block: 14 m radius at roof height, four azimuths, shallow pitch
for (const [name, dx, dz, yaw] of [
  ['cornice-nw', 10, -10, 135], ['cornice-ne', 10, 10, 225], ['cornice-se', -10, 10, 315], ['cornice-sw', -10, -10, 45],
]) {
  await evalJs(`window.__cam(${LAT + dx * M}, ${LON + dz * LM}, 17, ${yaw}, -6)`);
  await shot('cornice-' + name);
}
cp.kill();
srv.close();
console.log('done');
process.exit(0);
