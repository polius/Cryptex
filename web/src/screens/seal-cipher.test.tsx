// @vitest-environment jsdom
/** S3: the seal's scramble never shows what's being sent, masked or not, in any frame. */
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it } from 'vitest';
import { Cipher, cipherLines } from './Home';
import { emptyComposer, newRow } from './send/Composer';

describe('Cipher', () => {
  it('starts and stays random glyphs in the shape of the text', async () => {
    const secret = 'SuperSecretValue123';
    const lines = cipherLines({ ...emptyComposer(), fields: [newRow('DB_PASSWORD', secret, true)] });
    const root = document.createElement('div');
    document.body.append(root);
    await act(() => render(<Cipher lines={lines} />, root));
    const el = root.querySelector('.seal-cipher')!;
    const frames: string[] = [el.textContent!];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      frames.push(el.textContent!);
    }
    expect(new Set(frames).size).toBeGreaterThan(1); // it shuffles
    for (const f of frames) {
      expect(f).toHaveLength(`DB_PASSWORD  ${secret}`.length);
      for (let n = 4; n <= secret.length; n++) expect(f).not.toContain(secret.slice(0, n));
      expect(f).not.toContain('DB_PASS');
    }
    render(null, root);
  });
});
