// verify a standalone file:// artifact: opens grodno.html (no dev.js) and dev.html (with __shot),
// reports __ready / pack name / DOM label count, and saves a still from dev.html.
// usage: node tools/file-check.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'tools', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'atlas-file-'));
const port = 9800 + (Date.now() % 400);
const cp = spawn(CHROME, ['--window-position=60,60', '--window-size=1320,880', `--remote-debugging-port=${port}`,
  '--enable-unsafe-webgpu', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let nid = 0, ws = null;
const pend = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++nid; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
let list = null;
for (let i = 0; i < 40 && !list; i++) { await sleep(250); try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
if (!list) throw new Error('no CDP endpoint');
ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
  if (pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m); }
};
await send('Runtime.enable');
await send('Page.enable');
const ev = async (expression, awaitPromise = false) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })).result?.result?.value;
const open = async (file, query = 'auto&log&lv=1') => {
  await send('Page.navigate', { url: `file:///${path.join(ROOT, file).replace(/\\/g, '/')}?${query}` });
  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) { await sleep(200); ready = await ev('window.__ready === true'); }
  console.log(`${file}: ready=${ready}`, await ev("[document.getElementById('cn')?.textContent, document.querySelectorAll('#labs .lab').length]"));
  return ready;
};
const a = await open('grodno.html');
const b = await open('dev.html');
if (b) {
  await ev('window.__cam(53.66522728042709, 23.775503594418105, 35, 135, -18)');
  const s = await ev('window.__shot({ frames: 30 })', true);
  if (s) { writeFileSync(path.join(OUT, 'probe-file-grodno.png'), Buffer.from(s[0].split(',')[1], 'base64')); console.log('shot saved'); }
}
cp.kill();
process.exit(a && b ? 0 : 1);
