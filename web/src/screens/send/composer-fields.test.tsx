// @vitest-environment jsdom
/** S1, S2: the composer never changes a pasted secret behind its mask. Generate only fills an empty value, and a
 *  multi-line value (a private key) is never put through a one-line input, which would drop its line breaks. */
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPaste, Composer, emptyComposer, newRow, type ComposerState } from './Composer';

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\n';

describe('Composer fields', () => {
  const root = document.createElement('div');
  document.body.append(root);
  let state: ComposerState;
  const show = async (s: ComposerState) => {
    state = s;
    const onChange = (n: ComposerState) => { void show(n); };
    await act(() => render(<Composer state={state} onChange={onChange} maxChars={10000} maxFiles={5} maxFileBytes={1e8}
      onFilesRejected={() => undefined} registerPaste={() => undefined} />, root));
  };
  const buttons = (name: string) => Array.from(root.querySelectorAll('button')).filter((b) => b.textContent === name);
  afterEach(() => render(null, root));

  it('offers Generate only on an empty password value', async () => {
    await show({ ...emptyComposer(), fields: [newRow('DB_PASSWORD', 'k7#Qp2-vR9mL', true), newRow('AWS_SECRET_ACCESS_KEY', 'wJalrKEY', true), newRow('Password', '', true)] });
    expect(buttons('Generate')).toHaveLength(1);
    await act(() => buttons('Generate')[0].click());
    expect(state.fields[0].v).toBe('k7#Qp2-vR9mL');
    expect(state.fields[1].v).toBe('wJalrKEY');
    expect(state.fields[2].v).toHaveLength(20);
    expect(buttons('Generate')).toHaveLength(0); // it has a value now
  });

  it('keeps a private key whole: a summary while masked, a text area when shown', async () => {
    await show(applyPaste(emptyComposer(), KEY));
    expect(state.fields[0].v).toBe(KEY);
    expect(root.querySelector('input.v')).toBeNull();
    expect(root.querySelector('.v.multi-sum')!.textContent).toMatch(/^5 lines · /);
    await act(() => (root.querySelector('button[aria-label="Show"]') as HTMLButtonElement).click());
    const area = root.querySelector('textarea.v') as HTMLTextAreaElement;
    expect(area.value).toBe(KEY);
    // Type a space and delete it again.
    area.value = KEY + ' ';
    await act(() => { area.dispatchEvent(new Event("input", { bubbles: true })); });
    area.value = KEY;
    await act(() => { area.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(state.fields[0].v).toBe(KEY);
    expect(state.fields[0].v.split('\n')).toHaveLength(6);
  });
});
