/** Requests say who this tab believes is signed in, and a 401 to such a request means the session ended (R3). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, onSessionEnded, request, setSignedInAs } from './client';

const sent: Array<Record<string, string>> = [];
const answer = (status: number, body: unknown) => vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
  sent.push({ ...(init.headers as Record<string, string>) });
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
});

afterEach(() => {
  sent.length = 0;
  setSignedInAs(null);
  vi.unstubAllGlobals();
});

describe('X-Cryptex-User', () => {
  it('goes with every request while signed in, except the ones asking who is', async () => {
    answer(200, {});
    await request('GET', '/x');
    setSignedInAs('u1');
    await request('POST', '/secrets', { body: {} });
    await request('GET', '/config', { anonymous: true });
    expect(sent.map((h) => h['X-Cryptex-User'] ?? null)).toEqual([null, 'u1', null]);
  });

  it('a 401 sign_in_required to a request sent as someone ends the session; other errors don\'t', async () => {
    const ended = vi.fn();
    onSessionEnded(ended);
    setSignedInAs('u1');
    answer(401, { error: { code: 'sign_in_required', reason: 'ended' } });
    await expect(request('POST', '/secrets')).rejects.toBeInstanceOf(ApiError);
    expect(ended).toHaveBeenCalledTimes(1);
    answer(401, { error: { code: 'wrong_password' } });
    await expect(request('POST', '/me/vault/unlock')).rejects.toBeInstanceOf(ApiError);
    setSignedInAs(null);
    answer(401, { error: { code: 'sign_in_required' } });
    await expect(request('POST', '/auth/login/totp')).rejects.toBeInstanceOf(ApiError);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});
