// Size budgets, checked in CI and the image build right after `vite build`.
// Follows the Vite manifest from the entry through the route's screen chunk and its static imports, then deletes
// the manifest (dist/.vite): it maps every source file to its chunk and isn't something to serve.
// Usage: node scripts/budget.mjs [dist directory, default web/dist]
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const dist = process.argv[2] ? pathToFileURL(process.argv[2].replace(/\/?$/, '/')) : new URL('../dist/', import.meta.url);
const manifestFile = new URL('.vite/manifest.json', dist);
if (!existsSync(manifestFile)) {
  console.error(`No .vite/manifest.json in ${dist.pathname}: run \`npm run build\` first (this script deletes it after checking).`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestFile));
rmSync(new URL('.vite/', dist), { recursive: true, force: true });
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
// English is in the main bundle; a visitor in another language also loads that language's deck (one chunk each,
// one extra request). The largest is checked on its own and counted in the sender route, so no language goes over.
const decks = Object.keys(manifest).filter((k) => /(^|\/)copy\/[^/]+\.json$/.test(k));
if (!decks.length) throw new Error('no copy deck chunks in the manifest');
const deck = decks.reduce((a, b) => (gz(manifest[b].file) > gz(manifest[a].file) ? b : a));
const deckName = deck.replace(/^.*\//, '');

const budgets = [
  ['Recipient route /s/ (JS, without Argon2 or a language deck)', js(route('screens/reveal/Reveal.tsx')), 60 * KB],
  [`Largest language deck (${deckName}), loaded besides English`, js([deck]), 20 * KB],
  [`Sender route / (JS, with the largest language deck)`, js(new Set([...route('screens/Home.tsx'), deck])), 90 * KB],
  ['CSS', css, 25 * KB],
];
let failed = false;
for (const [name, size, max] of budgets) {
  const ok = size <= max;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${(size / KB).toFixed(1)} KB gzip (budget ${max / KB} KB)`);
}
process.exit(failed ? 1 : 0);
