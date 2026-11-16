// @vitest-environment jsdom
/** R1, R2: a one-time secret's only copy is on this page. The idle timeout hides it (Show again brings it back) and
 *  Clear now can be undone for a few seconds; a link that opens again is cleared at once, as before. */
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Revealed } from '../../flows/reveal';
import { Output, UNDO_MS } from './Output';

const data = (views_left: number | null): Revealed => ({
  items: [{ t: 'field', k: 'DB_PASSWORD', v: 'hunter2', secret: true }, { t: 'field', k: 'DB_HOST', v: 'db', secret: false }],
  files: [], views_left,
});

describe('Output timeout and Clear now', () => {
  const root = document.createElement('div');
  document.body.append(root);
  let cleared = 0;
  let d: Revealed;
  const show = (views: number | null) => {
    d = data(views);
    return act(() => render(<Output data={d} title="Prod" from={null} deletedNote="note" onCleared={() => cleared++} />, root));
  };
  const button = (name: string) => Array.from(root.querySelectorAll('button')).find((b) => b.textContent === name) as HTMLButtonElement | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    cleared = 0;
  });
  afterEach(() => {
    render(null, root);
    vi.useRealTimers();
  });

  it('one-time: the timeout hides the values and keeps them; Show again restores them', async () => {
    await show(0);
    await act(() => { vi.advanceTimersByTime(301_000); });
    expect(cleared).toBe(0);
    expect(d.items).toHaveLength(2);
    expect(root.textContent).not.toContain('db');
    expect(root.textContent).toContain('Hidden after 5 minutes');
    await act(() => button('Show again')!.click());
    expect(root.querySelectorAll('.out .field')).toHaveLength(2);
    expect(root.querySelector('.out .field .v.secret')).not.toBeNull(); // masked again
  });

  it('one-time: Clear now can be undone, then wipes when the undo time ends', async () => {
    await show(0);
    await act(() => button('Clear now')!.click());
    expect(cleared).toBe(0);
    await act(() => button('Undo')!.click());
    expect(root.querySelectorAll('.out .field')).toHaveLength(2);
    await act(() => button('Clear now')!.click());
    await act(() => { vi.advanceTimersByTime(UNDO_MS + 10); });
    expect(cleared).toBe(1);
    expect(d.items).toHaveLength(0);
  });

  it('reusable: the timeout and Clear now both wipe at once', async () => {
    await show(null);
    await act(() => { vi.advanceTimersByTime(301_000); });
    expect(cleared).toBe(1);
    expect(d.items).toHaveLength(0);
    render(null, root);
    await show(null);
    await act(() => button('Clear now')!.click());
    expect(cleared).toBe(2);
  });

  it('R4: .env only for two or more one-line fields; the clipboard note only after a copy', async () => {
    d = { items: [{ t: 'field', k: 'Private key', v: 'a\nb\n', secret: true }], files: [], views_left: null };
    await act(() => render(<Output data={d} title="" from={null} deletedNote="note" onCleared={() => undefined} />, root));
    expect(button('Copy all as .env')).toBeUndefined();
    expect(button('Save')).toBeDefined(); // a multi-line value saves as a file
    expect(root.textContent).not.toContain('stay in your clipboard');
    render(null, root);
    await show(null);
    expect(button('Copy all as .env')).toBeDefined();
  });
});
