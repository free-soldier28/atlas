// Serve the repo over HTTP with GitHub-Pages-style Range support and a manifest, so the browser
// loads packs/grodno.mpk in 64 KiB chunks instead of using the embedded copy.
// usage: node tools/serve.mjs [port]   → open the printed URL, watch the Network tab.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = +(process.argv[2] || 8080);
const MIME = { '.html': 'text/html', '.mpk': 'application/octet-stream', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };
createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/packs/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ cities: [{ id: 'grodno', name: 'Grodno', url: 'packs/grodno.mpk' }] }));
      return;
    }
    const b = await readFile(path.join(ROOT, p === '/' ? 'index.html' : p));
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (m) {
      const a = +m[1], z = Math.min(+m[2], b.length - 1);
      res.writeHead(206, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream',
        'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${z}/${b.length}`,
        'content-length': z - a + 1, 'access-control-allow-origin': '*' });
      res.end(b.subarray(a, z + 1));
    } else {
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream',
        'accept-ranges': 'bytes', 'access-control-allow-origin': '*' });
      res.end(b);
    }
  } catch { res.statusCode = 404; res.end('not found'); }
}).listen(PORT, () => console.log(`http://127.0.0.1:${PORT}/grodno.html — Network tab will show ~80 range requests for grodno.mpk`));
