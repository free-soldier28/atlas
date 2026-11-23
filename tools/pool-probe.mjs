// Phase B probe: ?pool=N keeps a fixed set of tiles and swaps them as the camera moves.
// usage: node tools/pool-probe.mjs
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
const dir = mkdtempSync(path.join(tmpdir(), 'atlas-pool-'));
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
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 500));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type.toUpperCase() + ' ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 500));
  if (pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m); }
};
await send('Runtime.enable'); await send('Page.enable');
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Page.navigate', { url: `${BASE}/dev.html?auto&pool=16&log&lv=1` });
let ready = false;
for (let i = 0; i < 300 && !ready; i++) { await sleep(200); ready = await ev('window.__ready === true'); }
if (!ready) { for (const l of logs) console.log(l); throw new Error('engine never became ready'); }
const before = await ev('window.__poolState()');
await ev('window.__shot({frames:1})');
const shotA = (await send('Page.captureScreenshot', { format: 'png' })).result;
const cam = await ev('window.__cam()');
console.log('cam', cam);
await ev('window.__shot({frames:1,pose:1})');
const changed = await ev('window.__stream()');
const after = await ev('window.__poolState()');
await ev('window.__shot({frames:1})');
const shotB = (await send('Page.captureScreenshot', { format: 'png' })).result;
writeFileSync(path.join(ROOT, 'tools', 'shots', 'probe-pool-before.png'), Buffer.from(shotA.data, 'base64'));
writeFileSync(path.join(ROOT, 'tools', 'shots', 'probe-pool-after.png'), Buffer.from(shotB.data, 'base64'));
for (const l of logs) console.log(l);
console.log(`before ${before}\nchanged ${changed} tiles\nafter  ${after}`);
cp.kill(); srv.close();
process.exit(before !== after && logs.length === 0 ? 0 : 1);
