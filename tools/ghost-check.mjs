// verify the "Walk through buildings" toggle: __surf() over a building roof must drop to ground
// after window.__ghost(1). usage: node tools/ghost-check.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engine, openPack } from '../pipeline/lib/worldharness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const E = await engine(), P = await openPack('packs/grodno.mpk'), S = P.h.tileSize;
let bx = 0, bz = 0;
for (let i = 0; i < P.h.tiles.length && !bx; i++) {
  const T = await E.mpkTile(P, i);
  for (const L of T.lods[T.lods.length - 1]) if (L.kind === 1 && L.recs.length) {
    const b = L.recs[0]; bx = T.x * S + b.pts[0] / 100 + 2; bz = T.z * S + b.pts[1] / 100 + 2; break;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'atlas-ghost-'));
const port = 9800 + (Date.now() % 400);
const cp = spawn(CHROME, ['--window-position=60,60', '--window-size=1320,880', `--remote-debugging-port=${port}`,
  '--enable-unsafe-webgpu', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let nid = 0, ws = null;
const pend = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++nid; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
let list = null;
for (let i = 0; i < 40 && !list; i++) { await sleep(250); try { list = await (await fetch('http://127.0.0.1:' + port + '/json')).json(); } catch {} }
ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
  if (pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m); }
};
await send('Runtime.enable'); await send('Page.enable');
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
await send('Page.navigate', { url: `file:///${path.join(ROOT, 'dev.html').replace(/\\/g, '/')}?auto&log&lv=1` });
let ready = false;
for (let i = 0; i < 300 && !ready; i++) { await sleep(200); ready = await ev('window.__ready === true'); }
if (!ready) throw new Error('engine never became ready');
const probe = `window.__surf('${bx.toFixed(1)},${bz.toFixed(1)},0')`;
const before = await ev(probe);
await ev('window.__ghost(1)');
const after = await ev(probe);
console.log(`building at ${bx.toFixed(1)},${bz.toFixed(1)}: before ${before} | ghost ${after}`);
cp.kill();
process.exit(before !== after && /floor 0\.9/.test(after) ? 0 : 1);
