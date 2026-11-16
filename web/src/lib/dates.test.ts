/** V1, first step: dates and times follow the browser's locale; relative times never say "tomorrow" for tonight. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const load = async (lang: string) => {
  vi.resetModules();
  vi.stubGlobal('navigator', { languages: [lang], language: lang });
  return import('./format');
};
afterEach(() => vi.unstubAllGlobals());

describe('dates', () => {
  const at = new Date(new Date().getFullYear(), 10, 14, 17, 18);
  it('follow the reader\'s locale', async () => {
    expect((await load('en-GB')).dateTime(at)).toMatch(/14 Nov.*17:18/);
    expect((await load('en-US')).dateTime(at)).toMatch(/Nov 14.*5:18\s?PM/);
    expect((await load('de-DE')).time(at)).toBe('17:18');
    expect((await load('es-ES')).date(at)).toMatch(/14 nov/);
  });

  it('show the year when it isn\'t this one, and the audit log always does', async () => {
    const f = await load('en-GB');
    expect(f.dateTime(new Date(2020, 2, 2, 9, 5))).toContain('2020');
    expect(f.fullStamp(at)).toContain(String(at.getFullYear()));
  });

  it('count hours up to 48 hours, then calendar days', async () => {
    const f = await load('en-GB');
    const now = new Date(2026, 10, 16, 1, 0).getTime();
    expect(f.relative(now + 21 * 3600_000, now)).toBe('in 21 hours'); // later today, not "tomorrow"
    expect(f.relative(now + 47 * 3600_000, now)).toBe('in 47 hours');
    expect(f.relative(now + 3 * 86400_000, now)).toBe('in 3 days');
    expect(f.relative(now - 5 * 60_000, now)).toBe('5 minutes ago');
  });
});
