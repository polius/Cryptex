/** Sizes, durations and dates, in the viewer's locale and time zone (frontend.md §9). */

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** 3600 → "1 hour", 86400 → "1 day", 604800 → "7 days". */
export function duration(seconds: number): string {
  const units: Array<[number, string]> = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [s, name] of units) {
    if (seconds >= s && seconds % s === 0) {
      const n = seconds / s;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.max(1, Math.round(seconds / 60))} minutes`;
}

/** "3 h 12 min", "4 min" (for countdowns to a reset). */
export function shortDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${Math.max(1, m)} min`;
}

const dtf = () => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const df = () => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const tf = () => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export const dateTime = (iso: string | number | Date) => dtf().format(new Date(iso));
export const date = (iso: string | number | Date) => df().format(new Date(iso));
export const time = (iso: string | number | Date) => tf().format(new Date(iso));

/** Short stamp for lists: time today, weekday + time this week, else date. */
export function stamp(iso: string | number | Date): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time(d);
  if (Math.abs(now.getTime() - d.getTime()) < 6 * 86400_000) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(d);
}

export function relative(iso: string | number | Date, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 20 * 3600) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function initials(name: string, email = ''): string {
  const src = name.trim() || email.split('@')[0];
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Expiry choices offered under a server maximum. */
export const EXPIRY_CHOICES = [3600, 86400, 7 * 86400, 30 * 86400];
export const VIEW_CHOICES = [1, 3, 10];
