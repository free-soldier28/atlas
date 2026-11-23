// Rebuild ALL shipped HTML artifacts with the same source and the same embedded pack (Grodno).
// Run after EVERY source/ or pack change: node source/build-all.mjs
//  - dev.html     : readable bundle + dev.js probes, embedded Grodno pack
//  - index.html   : packed bundle, embedded Grodno pack
//  - grodno.html  : named copy of index.html for the standalone file:// link
import { execFileSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const run = (...args) => execFileSync(process.execPath, [path.join(here, 'build.mjs'), ...args], { cwd: root, stdio: 'inherit' });

run('--dev', '--pack=packs/grodno.mpk');  // → dev.html
run('--pack=packs/grodno.mpk');           // → index.html
copyFileSync(path.join(root, 'index.html'), path.join(root, 'grodno.html'));
console.log(`grodno.html: standalone copy of index.html (${(statSync(path.join(root, 'grodno.html')).size / 1048576).toFixed(2)} MB)`);
