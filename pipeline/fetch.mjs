// downloads the Overpass JSON extracts for the Grodno pack into pipeline/cache/*.json (gitignored).
// Sequential queries (Overpass fair use), 4 retries per query on 429/502/504 with a 45 s backoff,
// alternating mirrors. A query that exhausts retries fails loudly (exit 1) — never fabricate data.
// Cached files are plain Overpass JSON exactly as returned; re-running skips what is already cached
// (pass --force to re-fetch). Node usage: node pipeline/fetch.mjs [--force]
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, 'cache');
mkdirSync(CACHE, { recursive: true });

const BBOX = '53.62,23.70,53.76,23.96'; // (south, west, north, east) = (minLat, minLon, maxLat, maxLon)
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
// `out geom` puts inline lat/lon on every point — no node-id resolution needed downstream.
const Q = (body) => `[out:json][timeout:300][maxsize:1073741824];\n${body}\nout geom;`;

const QUERIES = {
  buildings: Q(`(
  way["building"](${BBOX});
  relation["building"]["type"="multipolygon"](${BBOX});
);`),
  roads: Q(`way["highway"](${BBOX});`),
  water: Q(`(
  way["waterway"](${BBOX});
  way["natural"="water"](${BBOX});
  relation["natural"="water"](${BBOX});
);`),
  green: Q(`(
  way["leisure"~"^(park|garden|pitch|golf_course)$"](${BBOX});
  way["landuse"~"^(forest|grass|meadow|village_green|cemetery)$"](${BBOX});
);`),
};

const RETRIES = 4, BACKOFF_MS = 45_000, TIMEOUT_MS = 330_000; // > the query's own timeout:300
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryable = (status) => status === 429 || status === 502 || status === 504;

async function fetchQuery(name, query) {
  const file = path.join(CACHE, `${name}.json`);
  if (existsSync(file) && !process.argv.includes('--force')) {
    const n = JSON.parse(readFileSync(file, 'utf8')).elements.length;
    console.log(`fetch: ${name}: cached (${n} elements, ${(statSync(file).size / 1e6).toFixed(1)} MB)`);
    return n;
  }
  let lastErr = 'unknown';
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass 406s requests without a User-Agent; identify the pipeline.
          'User-Agent': 'atlas-mpk-pipeline/1.0 (OSM data packaging; one-off city extract)',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { throw Object.assign(new Error('response is not JSON'), { status: 0, soft: true }); }
      if (!Array.isArray(json.elements)) throw Object.assign(new Error('no elements array'), { status: 0, soft: true });
      if (json.remark && /timed out|out of memory|rate limit/i.test(json.remark))
        throw Object.assign(new Error(`overpass remark: ${json.remark}`), { status: 0, soft: true });
      writeFileSync(file, text); // exactly as returned
      console.log(`fetch: ${name}: ${json.elements.length} elements <- ${url} (${(text.length / 1e6).toFixed(1)} MB)`);
      return json.elements.length;
    } catch (e) {
      lastErr = e;
      const soft = e.soft || retryable(e.status) || /fetch failed|network|timeout|terminated/i.test(String(e.cause?.code || '') + e.message);
      if (!soft || attempt === RETRIES) break;
      console.log(`fetch: ${name}: ${e.message} — retry ${attempt + 1}/${RETRIES} via ${new URL(url).host} in ${BACKOFF_MS / 1000}s`);
      await sleep(BACKOFF_MS);
    }
  }
  console.error(`fetch: ${name} FAILED after ${RETRIES + 1} attempts: ${lastErr && lastErr.message}`);
  console.error(' refusing to continue without real data — delete pipeline/cache/*.json or fix connectivity, then re-run');
  process.exit(1);
}

let total = 0;
for (const [name, query] of Object.entries(QUERIES)) { // strictly sequential: fair use
  total += await fetchQuery(name, query);
}
console.log(`fetch: done, ${total} elements total across ${Object.keys(QUERIES).length} queries`);
