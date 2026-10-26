// Size budgets (frontend.md §11), checked in CI after `vite build`.
// Follows the Vite manifest from the entry through the route's screen chunk and its static imports.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const dist = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', dist)));
const KB = 1024;
const gz = (file) => gzipSync(readFileSync(new URL(file, dist)), { level: 9 }).length;

function closure(keys) {
  const seen = new Set();
  const walk = (k) => {
    if (seen.has(k)) return;
    seen.add(k);
    for (const i of manifest[k].imports ?? []) walk(i);
  };
  keys.forEach(walk);
  return seen;
}

const entry = Object.keys(manifest).find((k) => manifest[k].isEntry);
const route = (screen) => {
  const key = Object.keys(manifest).find((k) => k.endsWith(screen));
  if (!key) throw new Error(`no chunk for ${screen}`);
  return closure([entry, key]);
};
const js = (keys) => [...keys].reduce((n, k) => n + gz(manifest[k].file), 0);
const css = [...new Set(Object.values(manifest).flatMap((m) => m.css ?? []))].reduce((n, f) => n + gz(f), 0);

const budgets = [
  ['Recipient route /s/ (JS, without Argon2)', js(route('screens/reveal/Reveal.tsx')), 60 * KB],
  ['Responder route /q/ (JS)', js(route('screens/respond/Respond.tsx')), 60 * KB],
  ['Sender route / (JS)', js(route('screens/Home.tsx')), 90 * KB],
  ['CSS', css, 25 * KB],
];
let failed = false;
for (const [name, size, max] of budgets) {
  const ok = size <= max;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${(size / KB).toFixed(1)} KB gzip (budget ${max / KB} KB)`);
}
process.exit(failed ? 1 : 0);
