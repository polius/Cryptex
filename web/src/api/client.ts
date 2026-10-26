/** Typed fetch wrapper for /api/v1 (design/v3/spec/openapi.yaml). Errors become ApiError with the server's code. */

export class ApiError extends Error {
  code: string;
  status: number;
  field?: string;
  limit?: number;
  triesLeft?: number;
  resetAt?: string;
  reason?: string;
  at?: string;
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
  }
}

let csrf: string | null = null;
export const setCsrf = (v: string | null | undefined) => {
  csrf = v ?? null;
};

export interface Options {
  body?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function request(method: string, path: string, o: Options = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  let body: BodyInit | undefined;
  if (o.bytes) {
    body = o.bytes as Uint8Array<ArrayBuffer>;
    headers['Content-Type'] = 'application/octet-stream';
  } else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers['Content-Type'] = 'application/json';
  }
  if (method !== 'GET' && csrf) headers['X-CSRF'] = csrf;
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

export const cap = (scheme: 'Reveal' | 'Upload' | 'Manage' | 'Answer' | 'Read', token: string) => ({ Authorization: `${scheme} ${token}` });

// ------------------------------------------------------------------ shapes
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'member' | 'owner';
  mfa: boolean;
  sso: boolean;
}

export interface Config {
  version: string;
  mode: 'anyone' | 'signed_in';
  demo: boolean;
  setup_needed: boolean;
  signed_in: boolean;
  user: User | null;
  csrf?: string;
  brand: { name: string; logo_url: string | null; public_url: string };
  limits: {
    max_expires_in: number; max_views: number; max_message_chars: number; max_files: number; max_file_bytes: number;
    request_max_expires_in: number; request_max_keep: number;
  };
  defaults: { views: number; expires_in: number; access: 'link' };
  features: { email_access: boolean; org_access: boolean; notify: boolean; sso: boolean; sso_name: string; password_sign_in: boolean };
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
  views: number;
  expires_in: number;
  access: 'link' | 'email' | 'org';
  email?: string;
  passphrase: boolean;
  passphrase_salt?: string;
  notify: boolean;
}

export interface Event {
  type: string;
  at: string;
  detail: Record<string, unknown>;
}

export interface Receipt {
  id: string;
  kind: 'secret' | 'request';
  status: 'waiting' | 'opened' | 'answered' | 'revealed' | 'expired' | 'destroyed' | 'cancelled';
  reason?: string;
  views_left?: number | null;
  max_views?: number;
  created_at?: string;
  expires_at?: string;
  ended_at?: string;
  answered_at?: string | null;
  kept_until?: string | null;
  access?: string;
  passphrase?: boolean;
  events?: Event[];
}

export interface Meta {
  meta_ct: string;
  views_left: number;
  max_views: number;
  expires_at: string;
  access: 'link' | 'email' | 'org';
  email_hint?: string;
  org_name?: string;
  org_domains?: string[];
  passphrase: boolean;
  passphrase_salt?: string;
  tries_left?: number;
  size: number;
  files: number;
}
