/**
 * Strings come only from the copy deck, copy/en.json, through t(key, vars). Supports the ICU subset it uses: {var},
 * {n, plural, =0 {…} one {# …} other {# …}} and {x, select, a {…} other {…}}.
 */
import en from '../copy/en.json';

type Vars = Record<string, string | number | boolean | null | undefined>;
type Tree = { [k: string]: string | Tree };

/** The app is in English; dates, numbers and lists are formatted for it too. */
export const LOCALE = 'en';

const deck = en as unknown as Tree;
const plural = new Intl.PluralRules(LOCALE);

function find(key: string): string | undefined {
  let node: string | Tree | undefined = deck;
  for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined;
  return typeof node === 'string' ? node : undefined;
}

function lookup(key: string): string {
  const s = find(key);
  if (s === undefined) {
    if (import.meta.env?.DEV) console.warn(`missing copy: ${key}`);
    return key;
  }
  return s;
}

/** Split "a {b} c" into top-level literal and {…} segments, honoring nesting. */
function segments(s: string): Array<{ lit: string } | { arg: string }> {
  const out: Array<{ lit: string } | { arg: string }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') {
      if (depth === 0) {
        if (i > start) out.push({ lit: s.slice(start, i) });
        start = i + 1;
      }
      depth++;
    } else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        out.push({ arg: s.slice(start, i) });
        start = i + 1;
      }
    }
  }
  if (start < s.length) out.push({ lit: s.slice(start) });
  return out;
}

function options(body: string): Map<string, string> {
  const m = new Map<string, string>();
  const re = /\s*(=?\w+)\s*\{/g;
  let pos = 0;
  while (pos < body.length) {
    re.lastIndex = pos;
    const hit = re.exec(body);
    if (!hit) break;
    let depth = 1;
    let i = re.lastIndex;
    for (; i < body.length && depth; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') depth--;
    }
    m.set(hit[1], body.slice(re.lastIndex, i - 1));
    pos = i;
  }
  return m;
}

export function format(template: string, vars: Vars = {}, hash?: string): string {
  return segments(template).map((seg) => {
    if ('lit' in seg) return hash === undefined ? seg.lit : seg.lit.replace(/#/g, hash);
    const [name, type, ...rest] = seg.arg.split(',');
    const key = name.trim();
    const v = vars[key];
    if (!type) return v === undefined || v === null ? '' : String(v);
    const opts = options(rest.join(','));
    if (type.trim() === 'plural') {
      const n = Number(v ?? 0);
      const choice = opts.get(`=${n}`) ?? opts.get(plural.select(n)) ?? opts.get('other') ?? '';
      return format(choice, vars, new Intl.NumberFormat(LOCALE).format(n));
    }
    if (type.trim() === 'select') {
      return format(opts.get(String(v)) ?? opts.get('other') ?? '', vars, hash);
    }
    return String(v ?? '');
  }).join('');
}

export function t(key: string, vars?: Vars): string {
  return format(lookup(key), vars);
}

/**
 * t() for copy with markup inside: pass elements as vars and get back a list to render, e.g.
 * rich('send.shows_in', { links: <a href="/links">{t('app.nav_links')}</a> }) for "It shows in {links} …".
 */
export function rich<T>(key: string, vars: Record<string, T | string | number | boolean | null | undefined>): Array<string | T> {
  const marks: T[] = [];
  const plain: Vars = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v !== null && typeof v === 'object') {
      plain[k] = `\u0000${marks.length}\u0000`;
      marks.push(v as T);
    } else plain[k] = v as Vars[string];
  }
  return t(key, plain).split(/\u0000(\d+)\u0000/).map((part, i) => (i % 2 ? marks[Number(part)] : part)).filter((p) => p !== '');
}

export function has(key: string): boolean {
  return find(key) !== undefined;
}
