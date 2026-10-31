/** RFC 6238 codes for the e2e owner and invited people (the server rejects a code reused within its 30 s step). */
import { createHmac } from 'node:crypto';

export function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Try the current code; if the server already saw this step, wait for the next one and try again. */
export async function withCode(secret: string, attempt: (code: string) => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (await attempt(totp(secret))) return;
    await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 500));
  }
  throw new Error('no TOTP code was accepted');
}
