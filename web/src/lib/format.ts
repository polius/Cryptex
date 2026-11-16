/** Sizes, durations and dates, in the viewer's time zone. Words (units, "in 3 hours") are English like the copy;
 *  dates, times and plain numbers follow the browser's locale (V1): 17:18 in Madrid, 5:18 PM in New York. */
import { LOCALE } from './i18n';

/** The browser's locale for dates and numbers, falling back to English. */
export const READER = (() => {
  try {
    const l = typeof navigator !== 'undefined' ? navigator.languages?.[0] ?? navigator.language : undefined;
    return l ? Intl.DateTimeFormat.supportedLocalesOf([l])[0] ?? LOCALE : LOCALE;
  } catch {
    return LOCALE;
  }
})();

const unit = (n: number, u: string, unitDisplay: 'long' | 'short' = 'long') =>
  new Intl.NumberFormat(LOCALE, { style: 'unit', unit: u, unitDisplay }).format(n);

/** The unit word alone, agreeing with n: unitWord(1, 'hour') → "hour", unitWord(3, 'hour') → "hours". */
export function unitWord(n: number, u: 'minute' | 'hour' | 'day'): string {
  return new Intl.NumberFormat(LOCALE, { style: 'unit', unit: u, unitDisplay: 'long' }).formatToParts(n)
    .filter((x) => x.type === 'unit').map((x) => x.value).join('').trim();
}

/** 512 → "512 bytes", 48 MiB → "48 MB": binary steps. */
export function bytes(n: number): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return new Intl.NumberFormat(LOCALE, { style: 'unit', unit: units[u], unitDisplay: u ? 'short' : 'long', maximumFractionDigits: u && v < 10 ? 1 : 0 }).format(v);
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

const HM = { hour: 'numeric', minute: '2-digit' } as const;
/** The year only when it isn't this one. */
const year = (d: Date) => (d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {});
const fmt = (d: Date, o: Intl.DateTimeFormatOptions, locale = READER) => new Intl.DateTimeFormat(locale, o).format(d);

export const dateTime = (iso: string | number | Date) => {
  const d = new Date(iso);
  return fmt(d, { weekday: 'short', day: 'numeric', month: 'short', ...year(d), ...HM });
};
export const date = (iso: string | number | Date) => {
  const d = new Date(iso);
  return fmt(d, { weekday: 'short', day: 'numeric', month: 'short', ...year(d) });
};
export const time = (iso: string | number | Date) => fmt(new Date(iso), HM);
/** Date and time in full, for logs kept a long time (the audit log): never just "Mar 2". */
export const fullStamp = (iso: string | number | Date) => fmt(new Date(iso), { day: 'numeric', month: 'short', year: 'numeric', ...HM });

/** Short stamp for lists: time today, weekday + time this week, else the date. */
export function stamp(iso: string | number | Date): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time(d);
  if (Math.abs(now.getTime() - d.getTime()) < 6 * 86400_000) return fmt(d, { weekday: 'short', ...HM });
  return fmt(d, { day: 'numeric', month: 'short', ...year(d) });
}

/** "in 21 hours", "3 minutes ago", and from 48 hours on calendar days: "in 3 days". Never "tomorrow" for later today. */
export function relative(iso: string | number | Date, now = Date.now()): string {
  const at = new Date(iso).getTime();
  const diff = (at - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 48 * 3600) return rtf.format(Math.round(diff / 3600), 'hour');
  const day = (t: number) => {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400_000;
  };
  return rtf.format(day(at) - day(now), 'day');
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

export const num = (n: number) => new Intl.NumberFormat(READER).format(n);
