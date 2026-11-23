// startup timing probe: time from navigation to window.__ready, with the engine's ?log stage marks.
// usage: node tools/startup-time.mjs [url-path] (default dev.html?city=grodno&auto&log&lv=1)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.json': 'application/json', '.mpk': 'application/octet-stream' };
const srv = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
    res.end(await (await import('node:fs/promises')).readFile(path.join(ROOT, p === '/' ? 'index.html' : p)));
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'atlas-startup-'));
const port = 9800 + (Date.now() % 400);
const cp = spawn(CHROME, ['--window-position=60,60', '--window-size=1320,880', `--remote-debugging-port=${port}`,
  '--enable-unsafe-webgpu', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let nid = 0, ws = null;
const pend = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++nid; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
});
let list = null;
for (let i = 0; i < 40 && !list; i++) { await sleep(250); try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
if (!list) throw new Error('no CDP endpoint');
ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const marks = [];
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'log')
    marks.push(m.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' '));
  if (pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m); }
};
await send('Runtime.enable');
await send('Page.enable');
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
await send('Page.navigate', { url: `${BASE}/${process.argv[2] || 'dev.html?city=grodno&auto&log&lv=1'}` });
const t0 = Date.now();
let ready = false;
for (let i = 0; i < 300 && !ready; i++) { await sleep(200); ready = await evalJs('window.__ready === true'); }
console.log(`ready=${ready} wall=${((Date.now() - t0) / 1000).toFixed(2)} s page=${(await evalJs('performance.now()') / 1000).toFixed(2)} s`);
for (const m of marks) console.log(' ', m);
cp.kill(); srv.close();
process.exit(ready ? 0 : 1);
