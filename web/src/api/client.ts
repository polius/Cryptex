/** Typed fetch wrapper for /api/v1. Errors become ApiError with the server's code.
 *  The server's English `message` is kept for logs only: screens show copy picked by code, field and reason
 *  (screens/errors.ts). */

export class ApiError extends Error {
  code: string;
  status: number;
  field?: string;
  limit?: number;
  triesLeft?: number;
  resetAt?: string;
  reason?: string;
  at?: string;
  /** On `gone` for a secret: whether it was ever revealed. */
  opened?: boolean;
  retryAfter?: number;

  constructor(code: string, status: number, message = code, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.field = extra.field as string | undefined;
    this.limit = extra.limit as number | undefined;
    this.triesLeft = extra.tries_left as number | undefined;
    this.resetAt = extra.reset_at as string | undefined;
    this.reason = extra.reason as string | undefined;
    this.at = extra.at as string | undefined;
    this.opened = typeof extra.opened === 'boolean' ? extra.opened : undefined;
  }
}

let csrf: string | null = null;
export const setCsrf = (v: string | null | undefined) => {
  csrf = v ?? null;
};

// ------------------------------------------------------------------ who this tab believes is signed in
// Every request says so (X-Cryptex-User), so a session that ended elsewhere (signed out in another tab, a password
// change, a removal, a shared session's 12 hours) answers 401 sign_in_required instead of quietly acting
// anonymously, e.g. creating a link with no account behind it. lib/state.ts handles that 401 (onSessionEnded).
let signedInAs: string | null = null;
let sessionEnded: (() => void) | null = null;
export const setSignedInAs = (uid: string | null): void => {
  signedInAs = uid;
};
export const signedInUid = (): string | null => signedInAs;
export const onSessionEnded = (fn: () => void): void => {
  sessionEnded = fn;
};

export interface Options {
  body?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Leave out X-Cryptex-User: for the calls that ask who is signed in (GET /config, GET /auth/session). */
  anonymous?: boolean;
}

export async function request(method: string, path: string, o: Options = {}, retried = false): Promise<Response> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  const as = o.anonymous ? null : signedInAs;
  if (as) headers['X-Cryptex-User'] = as;
  let body: BodyInit | undefined;
  if (o.bytes) {
    body = o.bytes as Uint8Array<ArrayBuffer>;
    headers['Content-Type'] ??= 'application/octet-stream';
  } else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers['Content-Type'] = 'application/json';
  }
  const sentCsrf = csrf;
  if (method !== 'GET' && sentCsrf) headers['X-CSRF'] = sentCsrf;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body, signal: o.signal, credentials: 'same-origin', cache: 'no-store' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('offline', 0, 'offline');
  }
  if (!res.ok) {
    let err: Record<string, unknown> = {};
    try {
      err = ((await res.json()) as { error?: Record<string, unknown> }).error ?? {};
    } catch {
      /* not JSON: a proxy error page */
    }
    const e = new ApiError(String(err.code ?? (res.status >= 500 ? 'internal' : 'invalid')), res.status, String(err.message ?? res.statusText), err);
    const ra = res.headers.get('Retry-After');
    if (ra) e.retryAfter = Number(ra);
    // A CSRF token from before a sign-in in another tab (this tab's config reload hasn't caught up yet): fetch the
    // session's current one and send once more. Only for a request sent as someone: the server then checks it's
    // still them (401 if not), so the retry can never act for whoever is signed in now instead.
    if (as && !retried && e.status === 403 && e.reason === 'csrf') {
      const s = await api<{ csrf?: string | null }>('GET', '/auth/session', { anonymous: true }).catch(() => null);
      if (s?.csrf && s.csrf !== sentCsrf) {
        if (csrf === sentCsrf) setCsrf(s.csrf);
        return request(method, path, o, true);
      }
    }
    // Sent as someone and the server says nobody (or someone else) is signed in here: the session ended (the page
    // reloads). Not for a request sent as an account this tab has since left (a sign-in here as someone else).
    if (as && e.status === 401 && e.code === 'sign_in_required' && as === signedInAs) sessionEnded?.();
    throw e;
  }
  return res;
}

export async function api<T = unknown>(method: string, path: string, o: Options = {}): Promise<T> {
  const res = await request(method, path, o);
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export async function apiBytes(path: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await request('GET', path, { headers, signal });
  return new Uint8Array(await res.arrayBuffer());
}

export const cap = (scheme: 'Reveal' | 'Upload' | 'Manage' | 'Read' | 'Answer', token: string) => ({ Authorization: `${scheme} ${token}` });

// ------------------------------------------------------------------ shapes
export interface User {
  id: string;
  username: string;
  role: 'member' | 'owner';
  /** Signs in with a code from an authenticator app too (2FA is optional). */
  totp: boolean;
  /** An owner made a reset link for this account: shown at sign-in until dismissed. */
  notice: { by: string; at: string; pending: boolean } | null;
}

export interface Config {
  version: string;
  mode: 'anyone' | 'signed_in';
  demo: boolean;
  setup_needed: boolean;
  signed_in: boolean;
  user: User | null;
  csrf?: string;
  brand: { name: string; logo_url: string | null };
  limits: {
    max_expires_in: number; max_message_chars: number; max_files: number; max_file_bytes: number;
  };
  /** views: 1 for one-time links, null for links that open until they expire. */
  defaults: { views: 1 | null; expires_in: number };
  features: { sign_in: boolean };
  quota?: { used: number; limit: number; reset_at: string };
  pow_bits?: number;
}

export interface StreamDesc {
  stream: number;
  prefix: string;
  chunks: number;
  size: number;
}

export interface Policy {
  views: 1 | null;
  expires_in: number;
  passphrase: boolean;
  passphrase_salt?: string;
}

export interface Event {
  type: string;
  at: string;
  detail: Record<string, unknown>;
}

export interface Receipt {
  id: string;
  /** answered: a request's answer is in, and opens until it expires (GET /me/requests). */
  status: 'waiting' | 'opened' | 'expired' | 'destroyed' | 'answered';
  reason?: string;
  views_left?: number | null;
  max_views?: number | null;
  /** How many times it was opened so far. */
  views?: number;
  created_at?: string;
  expires_at?: string;
  ended_at?: string;
  passphrase?: boolean;
  /** For an ended link: whether it was ever revealed. */
  opened?: boolean;
  events?: Event[];
  /** A request ("Ask for a secret"): when the answer came, and the answer while it opens. */
  kind?: 'request';
  answered_at?: string;
  answer?: { id: string; key: string; expires_at: string; files: number; passphrase: boolean };
}

export interface Meta {
  meta_ct: string;
  /** The signed-in account that sent it, as the server knows it now; null for an anonymous sender. */
  sender?: string | null;
  views_left: number | null;
  max_views: number | null;
  expires_at: string;
  passphrase: boolean;
  passphrase_salt?: string;
  tries_left?: number;
  size: number;
  files: number;
}
