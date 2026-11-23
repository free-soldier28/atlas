// verify lazy startup: __ready comes with a focus-only world, __lazyFill completes it, and a
// rendered frame after filling looks identical to the full build. usage: node tools/lazy-probe.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'tools', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.mpk': 'application/octet-stream' };
const srv = createServer(async (req, res) => {
  try { const p = decodeURIComponent(new URL(req.url, 'http://x').pathname); res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream'); res.end(await (await import('node:fs/promises')).readFile(path.join(ROOT, p === '/' ? 'index.html' : p))); }
  catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'atlas-lazy-'));
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
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 600));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('ERR ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 600));
  if (pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m); }
};
await send('Runtime.enable'); await send('Page.enable');
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Page.navigate', { url: `${BASE}/${process.argv[2] || 'dev.html?auto&lazy&log&lv=1'}` });
let ready = false;
for (let i = 0; i < 300 && !ready; i++) { await sleep(200); ready = await ev('window.__ready === true'); }
if (!ready) { for (const l of logs) console.log(l); throw new Error('engine never became ready'); }
const early = await ev('window.__lazyProgress()');
const dbg = await ev('JSON.stringify({shot:typeof window.__shot,fill:typeof window.__lazyFill,prog:typeof window.__lazyProgress,p:window.__lazyProgress&&window.__lazyProgress()})');
console.log('hooks', dbg);
await ev('window.__shot({frames:1})');
const before = (await send('Page.captureScreenshot', { format: 'png' })).result;
const filled = await ev('window.__lazyFill()');
await ev('window.__shot({frames:1})');
const after = (await send('Page.captureScreenshot', { format: 'png' })).result;
const progress = await ev('window.__lazyProgress()');
for (const l of logs) console.log(l);
writeFileSync(path.join(OUT, 'probe-lazy-early.png'), Buffer.from(before.data, 'base64'));
writeFileSync(path.join(OUT, 'probe-lazy-filled.png'), Buffer.from(after.data, 'base64'));
console.log(`early ${early} → filled ${filled} tiles (${progress}); screenshots ${before.data.length} → ${after.data.length} bytes`);
// interactive default: no ?auto, no ?lazy — should still be lazy and keep filling during frames
await send('Page.navigate', { url: `${BASE}/dev.html?log&lv=1` });
await sleep(8000);
const live = await ev('JSON.stringify({ready:window.__ready,progress:window.__lazyProgress&&window.__lazyProgress()})');
console.log('interactive', live);
for (const l of logs) console.log(l);
const liveState = JSON.parse(live);
cp.kill(); srv.close();
process.exit(progress.startsWith('980/980') && liveState.ready && liveState.progress !== '9/980' ? 0 : 1);
