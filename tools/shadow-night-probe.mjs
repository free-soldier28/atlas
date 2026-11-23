// day/night smoke check after sharing the shadow maps: switch profile in AUTO mode, capture both.
// usage: node tools/shadow-night-probe.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.mpk': 'application/octet-stream' };
const srv = createServer(async (req, res) => {
  try { const p = decodeURIComponent(new URL(req.url, 'http://x').pathname); res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream'); res.end(await (await import('node:fs/promises')).readFile(path.join(ROOT, p === '/' ? 'index.html' : p))); }
  catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'atlas-shadow-'));
const port = 9800 + (Date.now() % 400);
const cp = spawn(CHROME, ['--window-position=60,60', '--window-size=1320,880', `--remote-debugging-port=${port}`,
  '--enable-unsafe-webgpu', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let nid = 0, ws = null;
const pend = new Map(), logs = [];
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++nid; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
let list = null;
for (let i = 0; i < 40 && !list; i++) { await sleep(250); try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ' ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 400));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 400));
  if (pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m); }
};
await send('Runtime.enable'); await send('Page.enable');
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) { console.log('EVAL EXC ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 400)); return undefined; } return r.result?.result?.value; };
await send('Page.navigate', { url: `${BASE}/dev.html?auto&lv=2&log&pool=8` });
let ready = false;
for (let i = 0; i < 300 && !ready; i++) { await sleep(200); ready = await ev('window.__ready === true'); }
if (!ready) { console.log(logs); throw new Error('engine never became ready'); }
await ev('window.__shot({frames:40})');
const day = (await send('Page.captureScreenshot', { format: 'png' })).result;
await ev('window.__night(1)');
await ev('window.__shot({frames:40})');
const night = (await send('Page.captureScreenshot', { format: 'png' })).result;
const state = await ev('window.__dbg()');
const proxy = await ev('window.__shadowProxy && window.__shadowProxy()');
const stats = await ev('window.__shadowStats()');
writeFileSync(path.join(ROOT, 'tools', 'shots', 'probe-shadow-day.png'), Buffer.from(day.data, 'base64'));
writeFileSync(path.join(ROOT, 'tools', 'shots', 'probe-shadow-night.png'), Buffer.from(night.data, 'base64'));
for (const l of logs) console.log(l);
console.log('state', state, 'proxy', proxy, 'maps', stats, 'day/night shots', day.data.length, night.data.length);
cp.kill(); srv.close();
const baked = stats && [1, 2, 3].every((k) => stats[k] && stats[k].variance > 0);
if (!baked) console.log('SHADOW MAPS LOST: one or more baked maps is a constant clear value');
process.exit(logs.length === 0 && proxy && proxy.ready && baked ? 0 : 1);
