// Brotli and gzip copies beside each text file of the build (D9), so the server can send the size the budgets
// measure without compressing anything per request: node scripts/compress.mjs dist
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const TEXT = /\.(js|css|html|svg|json|webmanifest|txt|map)$/;
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
let n = 0;
for (const f of walk(process.argv[2] ?? 'dist').filter((p) => TEXT.test(p))) {
  const raw = readFileSync(f);
  const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
  const gz = gzipSync(raw, { level: 9 });
  if (br.length < raw.length) writeFileSync(`${f}.br`, br);
  if (gz.length < raw.length) writeFileSync(`${f}.gz`, gz);
  n++;
}
console.log(`compressed ${n} files`);
