/**
 * Paste parser. The first rule that matches the
 * whole paste wins; otherwise it stays a note. The caller keeps the raw text for Undo.
 */
import { t } from '../lib/i18n';

export interface ParsedField {
  k: string;
  v: string;
  secret: boolean;
}

export type Parsed =
  | { kind: 'fields'; rule: 'pem' | 'env' | 'yaml' | 'url' | 'pair'; fields: ParsedField[] }
  | { kind: 'note'; text: string };

const SECRET_KEY = /pass|secret|token|key|pwd|private|credential|mnemonic|seed[\s_.-]*phrase|recovery[\s_.-]*(?:phrase|code)/i;
// The same words in other common languages, since people paste labels in their own. Words are matched as the start of a word (so inflected
// forms count: "Wi-Fi şifresi", "секретный"); short or ambiguous ones only as a whole word ("cle" isn't "clear",
// "пин" isn't "пингвин", "sandi" isn't "sandiwara", "pin" isn't "spin" or "pinned"). Japanese and Chinese have no
// spaces: their words match anywhere, and the one-character ones only at the end of a word ("APIキー", "秘密鍵", not
// "キーボード" or "鍵盤"). Words for a password or a secret also get "Generate" in the composer (isPasswordKey).
const PASSWORD_START = ['contraseña', 'contrasenya', 'secreto', 'mot de passe', 'passwort', 'kennwort', 'geheim', "parola d'ordine",
  'segreto', 'senha', 'segredo', 'wachtwoord', 'hasło', 'haslo', 'sekret', 'şifre', 'sifre', 'parola', 'gizli', 'пароль', 'гасло',
  'секрет', 'पासवर्ड', 'गुप्त', 'kata sandi', 'rahasia'];
const PASSWORD_WHOLE = ['mdp', 'sandi'];
const PASSWORD_ANYWHERE = ['パスワード', 'シークレット', '秘密', '密码', '口令', '비밀번호', '암호', '시크릿'];
const WORD_START = [...PASSWORD_START, 'clave', 'jeton', 'schlüssel', 'schluessel', 'chiave', 'chave', 'sleutel', 'toegangscode',
  'klucz', 'anahtar', 'belirteç', 'ключ', 'токен', 'कुंजी', 'टोकन', 'kunci'];
// PIN codes, one-time codes and card security codes (and the Russian and Ukrainian PIN) are secrets too.
const WHOLE_WORD = [...PASSWORD_WHOLE, 'clé', 'cle', 'clau', 'пин', 'пін', 'pin', 'otp', 'totp', 'cvv', 'cvc', 'cvv2'];
const ANYWHERE = [...PASSWORD_ANYWHERE, '暗証番号', 'トークン', '密钥', '秘钥', '令牌', '私钥', '토큰'];
const WORD_END = ['キー', '鍵', '키'];
const L = '[\\p{L}\\p{M}\\p{N}]'; // a letter (with its marks) or digit: anything else separates words
const words = (list: string[]) => list.map((w) => w.split(/[\s']+/).join("[\\s_.'’-]*")).join('|');
const matcher = (start: string[], whole: string[], anywhere: string[], end: string[]) => new RegExp(
  `(?:^|[^\\p{L}\\p{M}\\p{N}])(?:(?:${words(start)})|(?:${words(whole)})(?!${L}))|(?:${words(anywhere)})${end.length ? `|(?:${words(end)})(?!${L})` : ''}`, 'iu');
const SECRET_KEY_I18N = matcher(WORD_START, WHOLE_WORD, ANYWHERE, WORD_END);
const PASSWORD_KEY = /pass|pwd|secret/i;
const PASSWORD_KEY_I18N = matcher(PASSWORD_START, PASSWORD_WHOLE, PASSWORD_ANYWHERE, []);
const PEM = /^-----BEGIN ([A-Z0-9 ]+)-----\n[\s\S]*?\n-----END \1-----$/;
const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s?(.*)$/;
// A name in any language ("Пароль", "Contraseña", "Şifre", "パスワード"), then a colon and a space ("10:30" isn't one),
// or a full-width colon, which needs none.
const YAML_LINE = /^(\p{L}[\p{L}\p{M}\p{N}_ .()/'’-]{0,60}?)\s*(?::(?=\s|$)|：)\s*(.*)$/u;
// scheme://[user:password@]host[/path][?query][#fragment], read as browsers do (WHATWG URL): the host part ends at the
// first "/", "?" or "#", and the user and password are what comes before its last "@" (so a password may hold an
// "@"; a "/", "?" or "#" in one must be percent-encoded, as anywhere else). The user may be empty (redis://:pw@host).
const URL_PARTS = /^([a-z][a-z0-9+.-]*):\/\/(?:([^/?#\s:@]*):([^/?#\s]*)@)?([^/?#\s@]+)((?:[/?#]\S*)?)$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isSecretKey = (k: string) => SECRET_KEY.test(k) || SECRET_KEY_I18N.test(k.replace(/İ/g, 'i')); // Turkish capital İ doesn't case-fold

/** A field for a password or a secret, in English or another of those languages: the composer offers "Generate" there. */
export const isPasswordKey = (k: string) => PASSWORD_KEY.test(k) || PASSWORD_KEY_I18N.test(k.replace(/İ/g, 'i'));

/** A value that holds a secret whatever its name: a URL with a password in it (scheme://user:password@host), or with
 *  a secret-named query parameter (?password=…, &token=…). */
export function hasCredentials(v: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:[^\s/?#]*@/i.test(v.trim())) return true; // as URL_PARTS reads it
  return [...v.matchAll(/[?&]([^=&#\s]+)=/g)].some((m) => isSecretKey(decode(m[1])));
}

/** Percent-decoding only: a "+" stays a "+" (in a connection string's password or token it's never a space). */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A URL that holds a secret: a password (scheme://user:password@host), or secret-named query parameters
 *  (?password=…, &token=…), which become secret fields of their own; the rest of the query stays with the host. */
function urlFields(line: string): ParsedField[] | null {
  const m = URL_PARTS.exec(line);
  if (!m) return null;
  const [, scheme, user, pass, host, tail] = m;
  const [path, query = ''] = tail.split(/\?(.*)/s);
  const params = query.split('&').filter(Boolean).map((p) => {
    const at = p.indexOf('=');
    return at < 0 ? { name: p, value: '', raw: p } : { name: p.slice(0, at), value: p.slice(at + 1), raw: p };
  });
  const secrets = params.filter((p) => isSecretKey(decode(p.name)));
  if (pass === undefined && !secrets.length) return null;
  const rest = params.filter((p) => !secrets.includes(p)).map((p) => p.raw).join('&');
  return [
    { k: t('send.field_host'), v: host + (secrets.length ? path + (rest ? `?${rest}` : '') : tail), secret: false },
    ...(user ? [{ k: t('send.field_username'), v: decode(user), secret: false }] : []),
    ...(pass !== undefined ? [{ k: t('send.field_password'), v: decode(pass), secret: true }] : []),
    { k: t('send.field_type'), v: scheme.toLowerCase(), secret: false },
    ...secrets.map((p) => ({ k: decode(p.name), v: decode(p.value), secret: true })),
  ];
}

function normalize(raw: string): string[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

/** A value without its quotes. Unquoted, it ends at an inline comment (" # …"), except for a secret, where "#" is
 *  as likely part of the password (PASSWORD=abc #123), and cutting it would go unnoticed behind the mask. */
function unquote(v: string, secret = false): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    const inner = t.slice(1, -1);
    // One pass, so an escaped backslash followed by n (a\\nb in the file) stays a backslash and an n.
    return t[0] === '"' ? inner.replace(/\\(["\\n])/g, (_, c: string) => (c === 'n' ? '\n' : c)) : inner;
  }
  return secret ? t : t.replace(/\s+#.*$/, '');
}

function pemField(text: string): ParsedField | null {
  const m = PEM.exec(text);
  if (!m || text.split('-----BEGIN ').length !== 2) return null;
  const label = m[1];
  if (/PRIVATE KEY/.test(label)) return { k: t('send.field_private_key'), v: text, secret: true };
  if (/CERTIFICATE/.test(label)) return { k: t('send.field_certificate'), v: text, secret: false };
  return { k: label.charAt(0) + label.slice(1).toLowerCase(), v: text, secret: true };
}

function looksLikePassword(s: string): boolean {
  if (s.length < 8 || /\s/.test(s)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  return classes >= 2;
}

export function parsePaste(raw: string): Parsed {
  const lines = normalize(raw);
  const text = lines.join('\n');
  if (!lines.length) return { kind: 'note', text: raw };

  // 1 · one PEM block
  const pem = pemField(text.trim());
  if (pem) return { kind: 'fields', rule: 'pem', fields: [pem] };

  // 2 · every non-empty, non-# line is KEY=value
  const content = lines.filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (content.length && content.every((l) => ENV_LINE.test(l.trim()))) {
    const fields = content.map((l) => {
      const m = ENV_LINE.exec(l.trim())!;
      const v = unquote(m[2], isSecretKey(m[1]));
      return { k: m[1], v, secret: isSecretKey(m[1]) || hasCredentials(v) };
    });
    return { kind: 'fields', rule: 'env', fields };
  }

  // 3 · every line is `key: value` (2+ lines)
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length >= 2 && nonEmpty.every((l) => YAML_LINE.test(l.trim()) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(l.trim()))) {
    const fields = nonEmpty.map((l) => {
      const m = YAML_LINE.exec(l.trim())!;
      const v = unquote(m[2] ?? '', isSecretKey(m[1]));
      return { k: m[1].trim(), v, secret: isSecretKey(m[1]) || hasCredentials(v) };
    });
    return { kind: 'fields', rule: 'yaml', fields };
  }

  // 4 · one URL with credentials
  if (nonEmpty.length === 1) {
    const fields = urlFields(nonEmpty[0].trim());
    if (fields) return { kind: 'fields', rule: 'url', fields };
  }

  // 5 · two lines: identity, then secret
  if (nonEmpty.length === 2) {
    const [id, secret] = nonEmpty.map((l) => l.trim());
    if (!/\s/.test(id) && id.length <= 128 && !/\s/.test(secret) && (EMAIL.test(id) || looksLikePassword(secret))) {
      return { kind: 'fields', rule: 'pair', fields: [{ k: t('send.field_username'), v: id, secret: false }, { k: t('send.field_password'), v: secret, secret: true }] };
    }
  }

  // 6 · anything else
  return { kind: 'note', text: raw };
}
