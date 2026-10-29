import { describe, expect, it } from 'vitest';
import en from '../copy/en.json';
import { bytes, duration, shortDuration } from './format';
import { format, has, LANGUAGES, match, pick, t } from './i18n';

describe('t()', () => {
  it('substitutes variables', () => {
    expect(t('reveal.from', { sender: 'Sam Rivera', brand: 'Acme' })).toBe('Sam Rivera at Acme sent you');
  });

  it('handles plurals with #', () => {
    expect(t('send.detected', { count: 1 })).toBe('Found 1 field in your paste');
    expect(t('send.detected', { count: 3 })).toBe('Found 3 fields in your paste');
    expect(t('errors.wrong_passphrase', { tries: 4, sender: 'Sam' })).toBe(
      'That passphrase didn’t work. 4 tries left, then the secret is destroyed and Sam is told.');
  });

  it('handles =0, select and nesting', () => {
    expect(t('reveal.contents', { fields: 3, files: 1, both: true })).toBe('3 fields and 1 file');
    expect(t('reveal.contents', { fields: 0, files: 2, both: false })).toBe('2 files');
    expect(t('links.contents', { fields: 2, files: 0, both: false })).toBe('2 fields');
    expect(format('{n, plural, one {# day} other {# days}}', { n: 1000 })).toBe('1,000 days');
  });

  it('covers every API error code', () => {
    const codes = ['invalid', 'limit_exceeded', 'sign_in_required', 'forbidden', 'reauth_required', 'wrong_code',
      'not_found', 'already_sealed', 'setup_done', 'gone', 'too_large', 'wrong_passphrase', 'rate_limited',
      'demo_locked', 'internal', 'wrong_password', 'offline'];
    for (const c of codes) expect(has(`errors.${c}`), c).toBe(true);
    expect(Object.keys(en.errors).length).toBeGreaterThanOrEqual(codes.length);
  });
});

describe('format', () => {
  it('sizes', () => {
    expect(bytes(512)).toBe('512 bytes');
    expect(bytes(4096)).toBe('4 kB');
    expect(bytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
    expect(bytes(48 * 1024 ** 2)).toBe('48 MB');
  });

  it('durations', () => {
    expect(duration(3600)).toBe('1 hour');
    expect(duration(86400)).toBe('1 day');
    expect(duration(604800)).toBe('7 days');
    expect(duration(1800)).toBe('30 minutes');
    expect(shortDuration(3 * 3600 + 12 * 60)).toBe('3 hr 12 min');
    expect(shortDuration(200)).toBe('4 min');
  });
});

describe('languages', () => {
  it('matches browser languages to a deck', () => {
    expect(match(['ca-ES', 'en'])).toBe('ca');
    expect(match(['pt-BR'])).toBe('pt');
    expect(match(['zh-TW', 'zh'])).toBe('zh-CN');
    expect(match(['xx', 'de-AT'])).toBe('de');
    expect(match(['xx'])).toBeNull();
  });

  it('prefers this device, then the server, then the browser', () => {
    expect(pick('fr', 'ca', ['de'])).toBe('fr');
    expect(pick(null, 'ca', ['de'])).toBe('ca');
    expect(pick(null, 'auto', ['de-CH'])).toBe('de');
    expect(pick(null, 'auto', ['xx'])).toBe('en');
    expect(pick('xx', 'auto', ['es'])).toBe('es');
  });
});

/** Every {var} name used at any depth, and every plural/select argument with its options. */
function shape(s: string): { vars: string[]; plurals: Map<string, Set<string>> } {
  const vars = new Set<string>();
  const plurals = new Map<string, Set<string>>();
  const walk = (x: string) => {
    let depth = 0;
    let start = 0;
    for (let i = 0; i < x.length; i++) {
      if (x[i] === '{') { if (depth++ === 0) start = i + 1; }
      else if (x[i] === '}' && --depth === 0) {
        const body = x.slice(start, i);
        const [name, type, ...rest] = body.split(',');
        vars.add(name.trim());
        if (type) {
          const opts = rest.join(',');
          const keys = new Set<string>();
          let d = 0;
          let word = '';
          for (const ch of opts) {
            if (ch === '{') { if (d++ === 0) { keys.add(word.trim()); word = ''; } }
            else if (ch === '}') d--;
            else if (d === 0) word += ch;
          }
          if (type.trim() === 'plural') plurals.set(name.trim(), keys);
          // recurse into each option
          let dd = 0;
          let s0 = 0;
          for (let j = 0; j < opts.length; j++) {
            if (opts[j] === '{') { if (dd++ === 0) s0 = j + 1; }
            else if (opts[j] === '}' && --dd === 0) walk(opts.slice(s0, j));
          }
        }
      }
    }
  };
  walk(s);
  return { vars: [...vars].sort(), plurals };
}

function flat(tree: Record<string, unknown>, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    if (k === '_meta') continue;
    if (typeof v === 'string') out.set(prefix + k, v);
    else for (const [kk, vv] of flat(v as Record<string, unknown>, `${prefix}${k}.`)) out.set(kk, vv);
  }
  return out;
}

describe('copy decks', () => {
  const decks = import.meta.glob<Record<string, unknown>>('../copy/*.json', { eager: true, import: 'default' });
  const english = flat(en as Record<string, unknown>);

  it('has a deck for every language and nothing else', () => {
    const files = Object.keys(decks).map((p) => p.replace('../copy/', '').replace('.json', '')).sort();
    expect(files).toEqual(LANGUAGES.map((l) => l.code).sort());
  });

  // One word per concept ("account", "device", "sign in"), and one way of addressing people, per language (the decks drifted before).
  const DRIFT: Record<string, RegExp> = {
    ru: /уч[её]тн\p{L}* запис/iu, // аккаунт
    uk: /(?<!\p{L})акаунт/iu, // обліковий запис
    tr: /(?<!\p{L})(?:sen|sana|seni|senin|hesabın|şifreni|şifren)(?!\p{L})|\p{L}+(?:unuttun|yaptın|istemedin|abilirsin|ebilirsin|ersin|arsın)(?!\p{L})|oturum\p{L}*\s+aç/iu, // siz; giriş yap
    ko: /니다(?!\p{L})|니까\?/u, // 해요체, not 합니다체
    ja: /デバイス|ブラウザー|復元コード/u, // 端末, ブラウザ, リカバリーコード
    'zh-CN': /账户/u, // 账号
  };
  for (const [code, re] of Object.entries(DRIFT)) {
    it(`${code}: one word per concept and one form of address`, () => {
      const hits = [...flat(decks[`../copy/${code}.json`]).entries()].filter(([, s]) => re.test(s)).map(([k]) => k);
      expect(hits).toEqual([]);
    });
  }

  for (const [path, deck] of Object.entries(decks)) {
    const code = path.replace('../copy/', '').replace('.json', '');
    if (code === 'en') continue;
    it(`${code}: same keys, variables and plural forms as English`, () => {
      const ours = flat(deck);
      expect([...english.keys()].filter((k) => !ours.has(k)), 'missing').toEqual([]);
      expect([...ours.keys()].filter((k) => !english.has(k)), 'extra').toEqual([]);
      const rules = new Intl.PluralRules(code);
      const needed = new Set(Array.from({ length: 1001 }, (_, n) => rules.select(n))); // forms whole numbers up to 1,000 use
      for (const [k, s] of ours) {
        const a = shape(english.get(k)!);
        const b = shape(s);
        expect(b.vars, `${code} ${k} variables`).toEqual(a.vars);
        for (const [arg, forms] of b.plurals) {
          for (const f of needed) {
            // "one" may be covered by =1 when English has it, and "=0"-style exact forms are optional
            if (!forms.has(f) && !(f === 'one' && forms.has('=1'))) expect.fail(`${code} ${k}: plural {${arg}} lacks "${f}"`);
          }
        }
      }
    });
  }
});
