/** API errors are shown in the language on screen: by code, field and reason, never the server's English message. */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { errorText } from './errors';

const api = (code: string, status: number, extra: Record<string, unknown> = {}) => new ApiError(code, status, 'ENGLISH FROM THE SERVER', extra);

describe('errorText', () => {
  it('never shows the server message', () => {
    for (const e of [api('invalid', 400, { field: 'nope' }), api('forbidden', 403), api('limit_exceeded', 400), api('made_up', 418), api('internal', 500)]) {
      expect(errorText(e)).not.toContain('ENGLISH');
    }
  });

  it('picks words by field for invalid', () => {
    expect(errorText(api('invalid', 400, { field: 'current' }))).toBe('That isn’t your current password.');
    expect(errorText(api('invalid', 400, { field: 'username' }))).toBe('Someone already has that username.');
    expect(errorText(api('invalid', 400, { field: 'setup_code' }))).toContain('cryptex setup-code');
    expect(errorText(api('invalid', 400, { field: 'max_files', reason: 'locked' }))).toContain('environment');
    expect(errorText(api('invalid', 400, { field: 'streams[0].prefix' }))).toBe(errorText(api('invalid', 400)));
  });

  it('picks words by field for limits', () => {
    expect(errorText(api('limit_exceeded', 400, { field: 'streams', limit: 0 }))).toContain('paused');
    expect(errorText(api('limit_exceeded', 400, { field: 'streams', limit: 5 }))).toBe('Up to 5 files per link.');
    expect(errorText(api('limit_exceeded', 413, { field: 'streams[1].size', limit: 1024 ** 2 }))).toContain('1 MB');
    expect(errorText(api('limit_exceeded', 400, { field: 'policy.expires_in', limit: 86400 }))).toContain('1 day');
  });

  it('knows the last owner, rate limits without a time, and an unknown full disk', () => {
    expect(errorText(api('forbidden', 409))).toContain('at least one owner');
    expect(errorText(api('rate_limited', 429))).toBe('Too many tries. Try again later.');
    expect(errorText(api('rate_limited', 429, { reset_at: new Date(Date.now() + 120_000).toISOString() }))).toContain('2 min');
    expect(errorText(api('insufficient_storage', 507))).toContain('out of space');
    expect(errorText(api('wrong_password', 401))).toBe('That password didn’t work.');
    expect(errorText(api('wrong_password', 401, { field: 'current' }))).toBe('That isn’t your current password.');
  });

  it('explains errors from this page itself', () => {
    expect(errorText(new Error('weak_kdf'))).toContain('weaker');
    expect(errorText(new Error('locked'))).toContain('locked');
    expect(errorText(new Error('tampered'), 'Sam')).toContain('Sam');
  });

  it('reads the reasons the API sends', () => {
    expect(errorText(api('sign_in_required', 401, { reason: 'expired' }))).toContain('took too long');
    expect(errorText(api('forbidden', 403, { reason: 'csrf' }))).toContain('another tab');
    expect(errorText(api('forbidden', 409, { reason: 'last_owner' }))).toContain('at least one owner');
    expect(errorText(api('rate_limited', 429, { reason: 'demo_full', reset_at: new Date(Date.now() + 3_600_000).toISOString() }))).toContain('demo is full');
    expect(errorText(api('limit_exceeded', 400, { field: 'streams', limit: 0, reason: 'demo_files_paused' }))).toContain('paused');
    expect(errorText(api('wrong_code', 401, { tries_left: 3 }))).toBe('That code didn’t work. 3 tries left.');
    expect(errorText(api('wrong_code', 401, { tries_left: 0 }))).toContain('password again');
    expect(errorText(api('storage_full', 507, { limit: 0 }))).toContain('out of space');
    expect(errorText(api('invalid', 400, { field: 'user_id' }))).toContain('in the meantime');
    expect(errorText(api('invalid', 400, { field: 'logo' }))).toContain('UTF-8');
  });
});
