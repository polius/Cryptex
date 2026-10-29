import { describe, expect, it } from 'vitest';
import { eventText } from './labels';

const changed = (key: string, from: unknown, to: unknown) => eventText({ type: 'setting.changed', detail: { key, from, to } });

describe('audit log: setting changes', () => {
  it('shows limits in the units the Limits page uses', () => {
    expect(changed('max_file_size', 100 * 1024 ** 2, 2 * 1024 ** 3)).toBe('Setting changed · file size 100 MB → 2 GB');
    expect(changed('max_files', 5, 1)).toBe('Setting changed · files per link 5 files → 1 file');
    expect(changed('max_message_length', 10000, 500)).toBe('Setting changed · message length 10,000 characters → 500 characters');
    expect(changed('audit_retention_days', 365, 30)).toBe('Setting changed · audit retention 365 days → 30 days');
    expect(changed('max_expiration', 86400, 604800)).toBe('Setting changed · longest expiry 1 day → 7 days');
  });

  it('words values from the copy deck, not the API', () => {
    expect(changed('brand_logo', null, 'uploaded')).toBe('Setting changed · logo — → uploaded');
    expect(changed('brand_name', '', 'Acme')).toBe('Setting changed · name — → Acme');
    expect(changed('access', 'anyone', 'signed_in')).toBe('Setting changed · who can create links anyone → people with an account');
    expect(changed('language', 'auto', 'de')).toBe('Setting changed · language browser language → Deutsch');
  });
});
