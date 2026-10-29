/** The checks a reveal makes on what the server sends (docs/crypto.md §3.4), and file names made safe to show and save. */
import { describe, expect, it } from 'vitest';
import { utf8 } from '../crypto/format';
import { assemble, checkStreams, safeFileName } from './reveal';

const blobs = (...parts: string[]) => parts.map((p) => new Blob([utf8(p)]));
const manifest = (items: unknown[]) => blobs(JSON.stringify({ v: 1, items }));
const file = (name: string, size: number, stream: number) => ({ t: 'file', name, type: 'text/plain', size, stream });
const desc = (stream: number, chunks = 1) => ({ stream, prefix: 'AAAAAAAAAA', chunks, size: 16 * chunks });

describe('stream list', () => {
  it('accepts 0…n−1 in any order, and returns them in order', () => {
    expect(checkStreams([desc(1), desc(0), desc(2, 3)]).map((s) => s.stream)).toEqual([0, 1, 2]);
  });

  it('rejects an empty list, a gap, a repeat or a stream with no chunks', () => {
    for (const bad of [[], [desc(1)], [desc(0), desc(2)], [desc(0), desc(1), desc(1)], [desc(0), desc(1, 0)]]) {
      expect(() => checkStreams(bad), JSON.stringify(bad)).toThrow('tampered');
    }
  });

  it('rejects a list that isn\'t a list of objects', () => {
    for (const bad of [null, {}, [null], ['0']]) expect(() => checkStreams(bad as never), JSON.stringify(bad)).toThrow('tampered');
  });
});

describe('assemble', () => {
  it('builds notes, fields and files, from a file in several chunks', async () => {
    const out = await assemble([manifest([{ t: 'note', v: 'hi' }, file('a.txt', 6, 1)]), blobs('abc', 'def')], null);
    expect(out.items).toEqual([{ t: 'note', v: 'hi' }]);
    expect(out.files.map((f) => [f.name, f.size])).toEqual([['a.txt', 6]]);
    expect(await out.files[0].blob.text()).toBe('abcdef');
  });

  it('reads a manifest split across chunks', async () => {
    const json = JSON.stringify({ v: 1, items: [{ t: 'note', v: 'split' }] });
    expect((await assemble([blobs(json.slice(0, 7), json.slice(7))], 0)).items).toEqual([{ t: 'note', v: 'split' }]);
  });

  it('rejects a file whose size differs from the manifest (emptied or truncated)', async () => {
    await expect(assemble([manifest([file('a.txt', 3, 1)]), blobs('')], null)).rejects.toThrow('tampered');
  });

  it('rejects a missing, reused or unlisted stream', async () => {
    await expect(assemble([manifest([file('a.txt', 3, 1)])], null)).rejects.toThrow('tampered'); // stream 1 dropped
    await expect(assemble([manifest([file('a', 1, 1), file('b', 1, 1)]), blobs('x')], null)).rejects.toThrow('tampered');
    await expect(assemble([manifest([]), blobs('x')], null)).rejects.toThrow('tampered'); // a stream no item uses
    await expect(assemble([manifest([file('a', 1, 0)])], null)).rejects.toThrow('tampered'); // the manifest itself
    await expect(assemble([manifest([file('a', 1, '1' as never)]), blobs('x')], null)).rejects.toThrow('tampered');
  });

  it('rejects a manifest that is not JSON, not an object, or holds something that isn\'t an item', async () => {
    for (const m of ['not json', 'null', '[]', '{"v":1}', '{"v":1,"items":{}}', '{"v":1,"items":[null]}', '{"v":1,"items":[1]}']) {
      await expect(assemble([blobs(m)], null), m).rejects.toThrow('tampered');
    }
  });
});

describe('file names', () => {
  it('drops control, format and direction characters, path separators and leading dots', () => {
    expect(safeFileName('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(safeFileName('a\u0000b​c⁦d.txt')).toBe('abcd.txt');
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('.bashrc')).toBe('bashrc');
    expect(safeFileName(' ‎. ')).toBe('file');
    expect(safeFileName('notes.txt')).toBe('notes.txt');
  });
});
