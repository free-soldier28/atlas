// Shadow guard: fail if any baked shadow map is a constant clear value, in every render mode and
// after a day/night switch. Reads back the map contents via window.__shadowStats() in the engine.
// usage: node tools/shadow-guard.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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
const dir = mkdtempSync(path.join(tmpdir(), 'atlas-shadow-guard-'));
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
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 300));
  return r.result?.result?.value;
};
const check = (label, stats) => {
  const bad = [1, 2, 3].filter((k) => !stats?.[k] || !(stats[k].variance > 0));
  console.log(`${label}: ${bad.length ? 'FAIL maps ' + bad.join(',') : 'OK'} ${JSON.stringify(stats)}`);
  return bad.length === 0;
};
let ok = true;
for (const url of ['dev.html?auto&full&log&lv=1', 'dev.html?auto&lazy&log&lv=1', 'dev.html?auto&pool=16&log&lv=2']) {
  logs.length = 0;
  await send('Page.navigate', { url: `${BASE}/${url}` });
  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) { await sleep(200); ready = await ev('window.__ready === true'); }
  if (!ready) { console.log(url, 'engine never became ready', logs); ok = false; continue; }
  await ev('window.__shadowIdle()'); // a streaming re-bake may still be in flight at __ready
  ok = check(`${url} day`, await ev('window.__shadowStats()')) && ok;
  await ev('window.__night && window.__night(1)');
  await ev('window.__shadowIdle()');
  ok = check(`${url} night`, await ev('window.__shadowStats()')) && ok;
  if (logs.length) { console.log(url, logs); ok = false; }
}
cp.kill(); srv.close();
console.log(ok ? 'SHADOW GUARD PASSED' : 'SHADOW GUARD FAILED');
process.exit(ok ? 0 : 1);
