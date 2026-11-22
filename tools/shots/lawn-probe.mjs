// lawn probe: grazing views over courtyard lawns — reproduces the "grass looks like water"
// swirls and the bright skirts at building bases. usage: node tools/shots/lawn-probe.mjs
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
const dir = mkdtempSync(path.join(tmpdir(), 'atlas-lawn-'));
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
  if (m.method === 'Runtime.consoleAPICalled') { const s = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (m.params.type === 'error' || s.includes('error') || s.includes('shader')) console.log(`[${m.params.type}]`, s.slice(0, 300)); }
  if (m.method === 'Runtime.exceptionThrown') console.log('[EXC]', m.params.exceptionDetails.exception?.description?.slice(0, 300) || m.params.exceptionDetails.text);
  if (pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m); }
};
await send('Runtime.enable');
await send('Page.enable');
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
const evalAsync = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.navigate', { url: `${BASE}/dev.html?city=grodno&auto&log&lv=2` });
let ready = false;
for (let i = 0; i < 200 && !ready; i++) { await sleep(500); ready = await evalJs('window.__ready === true'); }
if (!ready) throw new Error('engine never became ready: ' + await evalJs('window.__err'));
console.log('ready, __info =', await evalJs('window.__info'));

const spots = [
  ['final-graze', 53.6822, 23.8255, 55, 210, -16],
  ['final-topdown', 53.6805, 23.8329, 55, 160, -87],
  ['final-river', 53.6805, 23.8270, 120, 250, -35],
];
for (const [name, lat, lon, y, yaw, pitch] of spots) {
  await evalJs("window.__cam(" + lat + ", " + lon + ", " + y + ", " + yaw + ", " + pitch + ")");
  const shot = await evalAsync('window.__shot({ frames: 30 })');
  if (!shot) { console.log('shot', name, 'null'); continue; }
  const data = shot[0].split(',')[1];
  writeFileSync(path.join(OUT, 'probe-' + name + '.png'), Buffer.from(data, 'base64'));
  console.log('shot', name, (data.length / 1024).toFixed(0), 'kB');
}
cp.kill();
srv.close();
console.log('done');
process.exit(0);
