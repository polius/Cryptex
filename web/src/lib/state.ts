/** App-wide state as signals: server config, the signed-in user, toasts, theme. */
import { signal } from '@preact/signals';
import { api, setCsrf, type Config } from '../api/client';

export const config = signal<Config | null>(null);
export const bootError = signal<string | null>(null);

export async function loadConfig(): Promise<Config> {
  const c = await api<Config>('GET', '/config');
  setCsrf(c.csrf);
  config.value = c;
  document.title = c.brand.name ? `${c.brand.name} · Secure share` : 'Cryptex';
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

// ------------------------------------------------------------------ Your links badge
export const linksCount = signal(0);
