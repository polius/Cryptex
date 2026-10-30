import { describe, expect, it } from 'vitest';
import en from '../copy/en.json';
import { bytes, duration, shortDuration } from './format';
import { format, has, t } from './i18n';

describe('t()', () => {
  it('substitutes variables', () => {
    expect(t('reveal.from', { sender: 'Sam Rivera', brand: 'Acme' })).toBe('Sam Rivera at Acme sent you');
  });

  it('handles plurals with #', () => {
    expect(t('send.detected', { count: 1 })).toBe('Found 1 field in your paste');
    expect(t('send.detected', { count: 3 })).toBe('Found 3 fields in your paste');
    expect(t('errors.wrong_passphrase', { tries: 4, sender: 'Sam' })).toBe(
      'That passphrase didn’t work. 4 tries left, then the secret is destroyed and Sam is told.');
  });

  it('handles =0, select and nesting', () => {
    expect(t('reveal.contents', { fields: 3, files: 1, both: true })).toBe('3 fields and 1 file');
    expect(t('reveal.contents', { fields: 0, files: 2, both: false })).toBe('2 files');
    expect(t('links.contents', { fields: 2, files: 0, both: false })).toBe('2 fields');
    expect(format('{n, plural, one {# day} other {# days}}', { n: 1000 })).toBe('1,000 days');
  });

  it('covers every API error code', () => {
    const codes = ['invalid', 'limit_exceeded', 'sign_in_required', 'forbidden', 'reauth_required', 'wrong_code',
      'not_found', 'already_sealed', 'setup_done', 'gone', 'too_large', 'wrong_passphrase', 'rate_limited',
      'demo_locked', 'internal', 'wrong_password', 'offline'];
    for (const c of codes) expect(has(`errors.${c}`), c).toBe(true);
    expect(Object.keys(en.errors).length).toBeGreaterThanOrEqual(codes.length);
  });
});

describe('format', () => {
  it('sizes', () => {
    expect(bytes(512)).toBe('512 bytes');
    expect(bytes(4096)).toBe('4 kB');
    expect(bytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
    expect(bytes(48 * 1024 ** 2)).toBe('48 MB');
  });

  it('durations', () => {
    expect(duration(3600)).toBe('1 hour');
    expect(duration(86400)).toBe('1 day');
    expect(duration(604800)).toBe('7 days');
    expect(duration(1800)).toBe('30 minutes');
    expect(shortDuration(3 * 3600 + 12 * 60)).toBe('3 hr 12 min');
    expect(shortDuration(200)).toBe('4 min');
  });
});
