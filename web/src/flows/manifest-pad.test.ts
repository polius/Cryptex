/** B8: the manifest is padded to a size step, so the server can't tell a PIN from an API key by its length; the
 *  recipient ignores the pad. */
import { describe, expect, it } from 'vitest';
import { paddedManifest } from './send';
import { assemble } from './reveal';

describe('paddedManifest', () => {
  it('pads to 1 KiB, then 4 KiB steps, and reads back without the pad', async () => {
    const pin = paddedManifest({ title: '', items: [{ t: 'field', k: 'PIN', v: '1234', secret: true }], files: [] });
    const key = paddedManifest({ title: '', items: [{ t: 'field', k: 'API_KEY', v: 'sk_live_' + 'x'.repeat(90), secret: true }], files: [] });
    expect(pin.length).toBe(1024);
    expect(key.length).toBe(1024);
    expect(paddedManifest({ title: '', items: [{ t: 'note', v: 'n'.repeat(5000) }], files: [] }).length).toBe(8192);
    const back = await assemble([[new Blob([pin as Uint8Array<ArrayBuffer>])]], null);
    expect(back.items).toEqual([{ t: 'field', k: 'PIN', v: '1234', secret: true }]);
  });
});
