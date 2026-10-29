/** Sizes, durations and dates, in the language on screen and the viewer's time zone. */
import { locale } from './i18n';

const L = () => locale.value;
const unit = (n: number, u: string, unitDisplay: 'long' | 'short' = 'long') =>
  new Intl.NumberFormat(L(), { style: 'unit', unit: u, unitDisplay }).format(n);

/** The unit word alone, agreeing with n: unitWord(1, 'hour') → "hour", unitWord(3, 'hour') → "hours". */
export function unitWord(n: number, u: 'minute' | 'hour' | 'day'): string {
  return new Intl.NumberFormat(L(), { style: 'unit', unit: u, unitDisplay: 'long' }).formatToParts(n)
    .filter((x) => x.type === 'unit').map((x) => x.value).join('').trim();
}

/** 512 → "512 bytes", 48 MiB → "48 MB" ("48 Mo" in French, "48 МБ" in Russian): binary steps, the language's own unit symbols. */
export function bytes(n: number): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return new Intl.NumberFormat(L(), { style: 'unit', unit: units[u], unitDisplay: u ? 'short' : 'long', maximumFractionDigits: u && v < 10 ? 1 : 0 }).format(v);
}

/** 3600 → "1 hour", 86400 → "1 day", 604800 → "7 days". */
export function duration(seconds: number): string {
  const units: Array<[number, string]> = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [s, name] of units) {
    if (seconds >= s && seconds % s === 0) return unit(seconds / s, name);
  }
  if (seconds >= 3600) return unit(Math.round(seconds / 3600), 'hour');
  return unit(Math.max(1, Math.round(seconds / 60)), 'minute');
}

/** "3 hr 12 min", "4 min" (for countdowns to a reset). */
export function shortDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s % 3600) / 60);
  if (h && m) return `${unit(h, 'hour', 'short')} ${unit(m, 'minute', 'short')}`;
  if (h) return unit(h, 'hour', 'short');
  return unit(Math.max(1, m), 'minute', 'short');
}

const dtf = () => new Intl.DateTimeFormat(L(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const df = () => new Intl.DateTimeFormat(L(), { weekday: 'short', day: 'numeric', month: 'short' });
const tf = () => new Intl.DateTimeFormat(L(), { hour: '2-digit', minute: '2-digit' });

export const dateTime = (iso: string | number | Date) => dtf().format(new Date(iso));
export const date = (iso: string | number | Date) => df().format(new Date(iso));
export const time = (iso: string | number | Date) => tf().format(new Date(iso));

/** Short stamp for lists: time today, weekday + time this week, else date. */
export function stamp(iso: string | number | Date): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time(d);
  if (Math.abs(now.getTime() - d.getTime()) < 6 * 86400_000) {
    return new Intl.DateTimeFormat(L(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat(L(), { day: 'numeric', month: 'short' }).format(d);
}

export function relative(iso: string | number | Date, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(L(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 20 * 3600) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

/** What people sign in with (api/cryptex/account.py USERNAME): 2 to 32 letters, numbers, dots, dashes or underscores. */
export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/i;

/** Shortest password the forms accept (setup, invites, password change). */
export const PASSWORD_MIN = 8;

/** Avatar letters from a username: "lisa.park" → "LP", "sam" → "S". */
export function initials(username: string): string {
  const parts = username.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Expiry choices offered under a server maximum. */
export const EXPIRY_CHOICES = [3600, 86400, 7 * 86400, 30 * 86400];
/** Lower case, no accents, for search: "Café" finds "cafe". */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The API's shortest expiry (routes/secrets.py). */
export const MIN_EXPIRES_IN = 300;
/** Any length works; the cap only stops a pasted novel from being hashed on every try. */
export const MAX_PASSPHRASE = 256;

export const num = (n: number) => new Intl.NumberFormat(L()).format(n);
