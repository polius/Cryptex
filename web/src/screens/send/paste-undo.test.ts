/** F6 (round 4): a paste anywhere on "/" is read into fields even when the composer already has content; Undo used
 *  to replace everything with the raw paste, losing what was there. Now it puts back what was there, with the
 *  paste added as text. */
import { describe, expect, it } from 'vitest';
import { applyPaste, emptyComposer, newRow, undoPaste } from './Composer';

describe('Undo after a paste', () => {
  it('keeps what was there before, and adds the paste as text', () => {
    const before = { ...emptyComposer(), title: 'prod', note: 'my earlier note\n', fields: [newRow('API_KEY', 'abc', true)] };
    const pasted = applyPaste(before, 'sam@acme.example\nk7#Qp2-vR9mL');
    expect(pasted.fields.map((f) => [f.k, f.v])).toEqual([['API_KEY', 'abc'], ['Username', 'sam@acme.example'], ['Password', 'k7#Qp2-vR9mL']]);
    const undone = undoPaste(pasted);
    expect(undone.title).toBe('prod');
    expect(undone.fields).toEqual(before.fields);
    expect(undone.note).toBe('my earlier note\nsam@acme.example\nk7#Qp2-vR9mL');
    expect(undone.detected).toBeNull();
  });

  it('into an empty composer, gives back the paste as typed', () => {
    const undone = undoPaste(applyPaste(emptyComposer(), 'DB_HOST=db\nDB_PASSWORD=x'));
    expect(undone.fields).toEqual([]);
    expect(undone.note).toBe('DB_HOST=db\nDB_PASSWORD=x');
  });
});
