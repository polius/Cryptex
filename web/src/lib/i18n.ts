/**
 * Strings come only from the copy decks in copy/, through t(key, vars). English is built in; every
 * other language is loaded on demand, and a key it lacks falls back to English. Supports the ICU
 * subset the copy deck uses: {var}, {n, plural, =0 {…} one {# …} other {# …}} and {x, select, a {…} other {…}}.
 */
import { signal } from '@preact/signals';
import en from '../copy/en.json';

type Vars = Record<string, string | number | boolean | null | undefined>;
type Tree = { [k: string]: string | Tree };

/** Every language with a copy deck, by its own name. Keep in step with LANGUAGES in api/cryptex/config.py. */
export const LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'ca', name: 'Català' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt', name: 'Português' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'ru', name: 'Русский' },
  { code: 'uk', name: 'Українська' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'zh-CN', name: '简体中文' },
];

const decks = import.meta.glob<Tree>(['../copy/*.json', '!../copy/en.json'], { import: 'default' });
const base = en as unknown as Tree;
let deck: Tree = base;
let plural = new Intl.PluralRules('en');

/** The language on screen. Components that read it re-render when it changes. */
export const locale = signal('en');

function find(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined;
  return typeof node === 'string' ? node : undefined;
}

function lookup(key: string): string {
  void locale.value; // every component that shows copy re-renders when the language changes
  const s = find(deck, key) ?? find(base, key);
  if (s === undefined) {
    if (import.meta.env?.DEV) console.warn(`missing copy: ${key}`);
    return key;
  }
  return s;
}

/** The best supported language for a list of BCP 47 tags (navigator.languages), or null. */
export function match(tags: readonly string[]): string | null {
  for (const tag of tags) {
    const exact = LANGUAGES.find((l) => l.code.toLowerCase() === tag.toLowerCase());
    if (exact) return exact.code;
    const lang = tag.split('-')[0].toLowerCase();
    const same = LANGUAGES.find((l) => l.code.split('-')[0] === lang);
    if (same) return same.code;
  }
  return null;
}

/** Which language to show: this device's choice, else the server's, else the browser's, else English. */
export function pick(device: string | null, server: string | null | undefined, browser: readonly string[]): string {
  if (device && LANGUAGES.some((l) => l.code === device)) return device;
  if (server && server !== 'auto' && LANGUAGES.some((l) => l.code === server)) return server;
  return match(browser) ?? 'en';
}

export async function setLocale(code: string): Promise<void> {
  const load = decks[`../copy/${code}.json`];
  deck = code !== 'en' && load ? await load() : base;
  const used = deck === base ? 'en' : code;
  plural = new Intl.PluralRules(used);
  if (typeof document !== 'undefined') document.documentElement.lang = used;
  locale.value = used;
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
      return format(choice, vars, new Intl.NumberFormat(locale.value).format(n));
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
  return find(deck, key) !== undefined || find(base, key) !== undefined;
}
