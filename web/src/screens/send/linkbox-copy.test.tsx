// @vitest-environment jsdom
/** S4: selecting the link by hand and copying gives the link, once, not the full one joined to the shortened one. */
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it } from 'vitest';
import { LinkBox } from './LinkReady';

describe('LinkBox', () => {
  it('copies exactly the link from a selection inside it', async () => {
    const link = 'http://localhost:18080/s/QqxRGwRjyk#po-ZP2v3ezi6Kh1lgTFH7Q';
    const root = document.createElement('div');
    document.body.append(root);
    await act(() => render(<LinkBox link={link} />, root));
    const url = root.querySelector('.linkbox .url')!;
    getSelection()!.selectAllChildren(url); // a triple-click
    const data = new Map<string, string>();
    const e = Object.assign(new Event('copy', { bubbles: true, cancelable: true }), { clipboardData: { setData: (k: string, v: string) => data.set(k, v) } });
    url.querySelector('.short')!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(data.get('text/plain')).toBe(link);
    render(null, root);
  });
});
