// @vitest-environment jsdom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { H1, useViewFocus } from './bits';

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function Steps({ view }: { view: string | null }) {
  useViewFocus(view);
  if (view === null) return <main id="main" aria-busy="true" />;
  return (
    <main id="main">
      <H1>{view}</H1>
      {view === 'code' && <input id="code" data-autofocus />}
      <button id="go">Go</button>
    </main>
  );
}

describe('useViewFocus', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const show = async (view: string | null) => {
    await act(() => render(<Steps view={view} />, root));
    await frame();
  };
  const active = () => document.activeElement?.id || document.activeElement?.tagName.toLowerCase();
  afterEach(() => render(null, root));

  it('focuses the heading when content arrives after a load', async () => {
    await show(null);
    await show('password');
    expect(active()).toBe('h1');
  });

  it('focuses the next step\'s first field, or its heading', async () => {
    await show('password');
    document.getElementById('go')!.focus(); // the button that submitted the step
    await show('code');
    expect(active()).toBe('code');
    await show('sent');
    expect(active()).toBe('h1');
  });

  it('leaves focus the person moved out of the page', async () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    await show('password');
    outside.focus();
    await show('code');
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe('Dialog', () => {
  it('keeps focus while open, and the latest one shows on top', async () => {
    const { Dialog } = await import('./dialog');
    const root = document.createElement('div');
    document.body.append(root);
    const behind = document.createElement('button');
    document.body.append(behind);
    await act(() => render(<>
      <Dialog open onClose={() => undefined} labelledBy="a"><h2 id="a">A</h2><input id="in-a" data-autofocus /></Dialog>
      <Dialog open onClose={() => undefined} labelledBy="b"><h2 id="b">B</h2><input id="in-b" data-autofocus /></Dialog>
    </>, root));
    const [a, b] = Array.from(root.querySelectorAll<HTMLElement>('.scrim'));
    expect(Number(b.style.zIndex)).toBeGreaterThan(Number(a.style.zIndex));
    behind.focus(); // a screen behind the dialogs finished loading and focused its heading
    expect(document.activeElement?.id).toBe('in-b');
    render(null, root);
    root.remove();
    behind.remove();
  });
});

describe('focus after a dialog or a save bar goes away', () => {
  // jsdom lays nothing out: an element counts as shown when it's in the document (dialog.tsx checks offsetParent).
  const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  beforeAll(() => Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.isConnected ? document.body : null; } }));
  afterAll(() => offsetParent && Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent));

  it('a dialog opened after a request goes back to the button that started it', async () => {
    const { Dialog } = await import('./dialog');
    await frame(); // the last test's dialogs finish closing first
    const root = document.createElement('div');
    document.body.append(root);
    root.innerHTML = '<h1 data-page-heading tabindex="-1">Account</h1><button id="move">Move 2FA</button>';
    const button = root.querySelector<HTMLElement>('#move')!;
    const host = document.createElement('div');
    root.append(host);
    button.focus();
    button.setAttribute('disabled', ''); // busy while the request is out: focus falls to the page
    button.blur();
    await act(() => render(<Dialog open onClose={() => undefined} labelledBy="x" returnTo={button}><h2 id="x">X</h2><input data-autofocus /></Dialog>, host));
    button.removeAttribute('disabled');
    await act(() => render(null, host));
    await frame();
    expect(document.activeElement).toBe(button);
    root.remove();
  });

  it('Save or Discard puts focus back on the edited field', async () => {
    const { SaveBar } = await import('../screens/server/common');
    const root = document.createElement('div');
    document.body.append(root);
    const field = document.createElement('input');
    field.id = 'b-name';
    document.body.append(field);
    const bar = (on: boolean) => render(on ? <SaveBar summary="1 unsaved change" busy={false} onDiscard={() => undefined} onSave={() => undefined}
      back={() => document.getElementById('b-name')} /> : null, root);
    await act(() => bar(true));
    root.querySelector<HTMLElement>('.savebar button')!.focus();
    await act(() => bar(false));
    await frame();
    expect(document.activeElement).toBe(field);
    field.remove();
    root.remove();
  });
});

describe('dialog forms', () => {
  it('have one submit button, in the footer, tied to the form by id (no hidden duplicate)', async () => {
    const { ApiError } = await import('../api/client');
    const { ReauthDialog, sensitive } = await import('../screens/server/common');
    const root = document.createElement('div');
    document.body.append(root);
    await act(() => render(<ReauthDialog />, root));
    await act(() => sensitive(async () => { throw new ApiError('reauth_required', 403); }));
    const dialog = root.querySelector('[role=dialog]')!;
    const confirms = Array.from(dialog.querySelectorAll('button')).filter((b) => b.textContent === 'Confirm');
    expect(confirms).toHaveLength(1);
    expect(confirms[0].type).toBe('submit');
    expect(confirms[0].closest('.dialog-f')).not.toBeNull();
    expect(confirms[0].form?.id).toBe('ra-form');
    render(null, root);
    root.remove();
  });

  it('no screen hides a submit button for Enter: the visible one submits its form', () => {
    const sources = import.meta.glob<string>('../**/*.tsx', { eager: true, query: '?raw', import: 'default' });
    const hidden = Object.entries(sources).filter(([, src]) => /<button[^>]*type="submit"[^>]*class="sr"|<button[^>]*class="sr"[^>]*type="submit"/.test(src)).map(([p]) => p);
    expect(hidden).toEqual([]);
  });
});
