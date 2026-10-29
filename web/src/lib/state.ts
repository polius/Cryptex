/** App-wide state as signals: server config, the signed-in user, toasts, theme. */
import { signal } from '@preact/signals';
import { api, onSessionEnded, setCsrf, setSignedInAs, signedInUid, type Config, type User } from '../api/client';
import { locale, pick, setLocale, t } from './i18n';

export const config = signal<Config | null>(null);
export const bootError = signal<string | null>(null);

/** The demo has no accounts. Its menu and Your account page show this sample owner (the Server tour's), read-only. */
export const DEMO_USER: User = { id: 'u1', username: 'demo', role: 'owner', totp: false, notice: null };

/** Who the menu and Your account show: the signed-in person, or the demo's sample owner. */
export const shownUser = (c: Config | null = config.value): User | null => (c?.user && c.signed_in ? c.user : c?.demo ? DEMO_USER : null);

/** The account vault, once loaded: only for signed-in people, so recipients' pages stay small. */
let vaultModule: typeof import('../store/vault') | null = null;

export async function loadConfig(): Promise<Config> {
  const before = signedInUid();
  const c = await api<Config>('GET', '/config', { anonymous: true });
  const uid = c.signed_in && c.user ? c.user.id : null;
  if (before && before !== uid) {
    sessionEnded(); // signed out (or in as someone else) behind this tab's back
    return new Promise<Config>(() => undefined); // the page reloads
  }
  setCsrf(c.csrf);
  setSignedInAs(uid);
  const lang = pick(deviceLanguage.value, c.language, navigator.languages ?? [navigator.language]);
  if (lang !== locale.value) await setLocale(lang).catch(() => undefined);
  config.value = c;
  if (uid) {
    vaultModule ??= await import('../store/vault');
    await vaultModule.syncVault(uid).catch(() => undefined);
  }
  document.title = c.brand.name ? `${c.brand.name} · ${t('app.brand_suffix')}` : 'Cryptex';
  if (c.demo && !document.querySelector('meta[name="robots"]')) {
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex, nofollow';
    document.head.appendChild(m);
  }
  return c;
}

export const cfg = (): Config => {
  if (!config.value) throw new Error('config not loaded');
  return config.value;
};

// ------------------------------------------------------------------ toasts (polite live region)
export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}
export const toasts = signal<Toast[]>([]);
let toastSeq = 0;

export function toast(text: string, kind: Toast['kind'] = 'success'): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value.filter((t) => t.text !== text), { id, kind, text }];
  if (kind !== 'error') setTimeout(() => dismiss(id), 4000); // errors stay until dismissed
}

export const dismiss = (id: number) => {
  toasts.value = toasts.value.filter((t) => t.id !== id);
};

// ------------------------------------------------------------------ theme
export type Theme = 'auto' | 'light' | 'dark';
const KEY = 'cx-theme';
export const theme = signal<Theme>(readTheme());

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme(t: Theme = theme.value): void {
  const dark = t === 'dark' || (t === 'auto' && !!media?.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0B0E12' : '#F4F6F9');
}

export function setTheme(t: Theme): void {
  theme.value = t;
  try {
    if (t === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  applyTheme(t);
}

media?.addEventListener('change', () => applyTheme());

// ------------------------------------------------------------------ the session ending elsewhere
// Signed out in another tab, a password change or removal, an owner's reset, a shared session's 12 hours: this tab
// finds out from a 401 to a request it sent as the signed-in person (api/client.ts), from another tab
// (BroadcastChannel), or when it's shown again (visibilitychange). It forgets the vault key and reloads: nothing it
// showed or decrypted for the account stays, and the page starts again for whoever is signed in now.
const channel = typeof window !== 'undefined' && typeof BroadcastChannel === 'function' ? new BroadcastChannel('cryptex') : null;

export function sessionEnded(): void {
  vaultModule?.lockVault();
  location.reload();
}

/** Tell this browser's other tabs that `uid` signed out here (they reload). */
export const announceSignOut = (uid: string): void => channel?.postMessage({ type: 'signed-out', uid });

/** Is this tab's account still the one signed in? A different one, or none: the session ended. */
export async function checkSession(): Promise<void> {
  const uid = signedInUid();
  if (!uid) return;
  const s = await api<{ user: { id: string } | null; shared?: boolean }>('GET', '/auth/session', { anonymous: true }).catch(() => null);
  if (!s || signedInUid() !== uid) return; // offline (ask again next time), or it changed meanwhile
  if (s.user?.id !== uid) sessionEnded();
  else await vaultModule?.noteSession(uid, !!s.shared);
}

onSessionEnded(sessionEnded);
channel?.addEventListener('message', (e: MessageEvent<{ type?: string; uid?: string }>) => {
  if (e.data?.type === 'signed-out' && e.data.uid && e.data.uid === signedInUid()) sessionEnded();
});
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkSession();
  });
}

// ------------------------------------------------------------------ Your links badge
export const linksCount = signal(0);
let counting = 0;

/** A count from Your links' own status read: newer than any count still being worked out. */
export function setLinksCount(n: number): void {
  counting++;
  linksCount.value = n;
}

/** Count again: at boot, after a send, and once the vault opens. Only the latest count is shown. */
export function countLinks(): void {
  const n = ++counting;
  void import('../screens/links/sync').then((m) => m.waitingCount()).then((c) => {
    if (n === counting) linksCount.value = c;
  }, () => undefined);
}

// ------------------------------------------------------------------ language (this device's choice; null follows the server)
const LANG_KEY = 'cx-lang';
export const deviceLanguage = signal<string | null>(readLanguage());

function readLanguage(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

export async function setDeviceLanguage(code: string | null): Promise<void> {
  deviceLanguage.value = code;
  try {
    if (code) localStorage.setItem(LANG_KEY, code);
    else localStorage.removeItem(LANG_KEY);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  await setLocale(pick(code, config.value?.language, navigator.languages ?? [navigator.language]));
  const c = config.value;
  if (c) document.title = c.brand.name ? `${c.brand.name} · ${t('app.brand_suffix')}` : 'Cryptex';
}
