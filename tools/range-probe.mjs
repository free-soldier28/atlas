// browser check of the HTTP range path: a local server that honours Range like GitHub Pages,
// plus a manifest entry so the loader prefers the network pack over the embedded copy.
// usage: node tools/range-probe.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.mpk': 'application/octet-stream', '.json': 'application/json' };
const srv = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/packs/manifest.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ cities: [{ id: 'grodno', name: 'Grodno', url: 'packs/grodno.mpk' }] }));
      return;
    }
    const b = await (await import('node:fs/promises')).readFile(path.join(ROOT, p === '/' ? 'index.html' : p));
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (m) {
      const a = +m[1], z = Math.min(+m[2], b.length - 1);
      res.writeHead(206, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream',
        'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${z}/${b.length}`, 'content-length': z - a + 1 });
      res.end(b.subarray(a, z + 1));
    } else {
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'accept-ranges': 'bytes' });
      res.end(b);
    }
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'atlas-range-'));
const port = 9800 + (Date.now() % 400);
const cp = spawn(CHROME, ['--window-position=60,60', '--window-size=1320,880', `--remote-debugging-port=${port}`,
  '--enable-unsafe-webgpu', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let nid = 0, ws = null;
const pend = new Map(), logs = [], reqs = [];
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++nid; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
let list = null;
for (let i = 0; i < 40 && !list; i++) { await sleep(250); try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'log') logs.push(m.params.args.map((a) => a.value || a.description).join(' '));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type.toUpperCase() + ' ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 400));
  if (pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m); }
};
await send('Runtime.enable'); await send('Page.enable');
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
srv.on('request', (q) => { if (q.url.endsWith('.mpk')) reqs.push(q.headers.range || 'FULL'); });
const t0 = Date.now();
await send('Page.navigate', { url: `${BASE}/${process.argv[2] || 'dev.html?city=grodno&auto&log&lv=1'}` });
let ready = false;
for (let i = 0; i < 300 && !ready; i++) { await sleep(200); ready = await ev('window.__ready === true'); }
for (const l of logs) console.log(' ', l);
console.log(`ready=${ready} wall=${((Date.now() - t0) / 1000).toFixed(2)}s mpk requests=${reqs.length}`);
console.log('  first ranges', reqs.slice(0, 4), 'last', reqs.at(-1));
cp.kill(); srv.close();
process.exit(ready && logs.some((l) => l.includes('pack source: range')) && !logs.some((l) => l.startsWith('ERROR')) ? 0 : 1);
