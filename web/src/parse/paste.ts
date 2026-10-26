/**
 * Paste parser (design/v3/spec/frontend.md §5). The first rule that matches the
 * whole paste wins; otherwise it stays a note. The caller keeps the raw text for Undo.
 */

export interface ParsedField {
  k: string;
  v: string;
  secret: boolean;
}

export type Parsed =
  | { kind: 'fields'; rule: 'pem' | 'env' | 'yaml' | 'url' | 'pair'; fields: ParsedField[] }
  | { kind: 'note'; text: string };

const SECRET_KEY = /pass|secret|token|key|pwd|private|credential/i;
const PEM = /^-----BEGIN ([A-Z0-9 ]+)-----\n[\s\S]*?\n-----END \1-----$/;
const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s?(.*)$/;
const YAML_LINE = /^([A-Za-z][\w .()/-]{0,60}?)\s*:(?:\s+(.*)|)$/;
const URL_CREDS = /^([a-z][a-z0-9+.-]*):\/\/([^:@/\s]+):([^@\s]*)@(\S+)$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isSecretKey = (k: string) => SECRET_KEY.test(k);

function normalize(raw: string): string[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    const inner = t.slice(1, -1);
    return t[0] === '"' ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
  }
  return t.replace(/\s+#.*$/, ''); // unquoted values end at an inline comment
}

function pemField(text: string): ParsedField | null {
  const m = PEM.exec(text);
  if (!m || text.split('-----BEGIN ').length !== 2) return null;
  const label = m[1];
  if (/PRIVATE KEY/.test(label)) return { k: 'Private key', v: text, secret: true };
  if (/CERTIFICATE/.test(label)) return { k: 'Certificate', v: text, secret: false };
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
      return { k: m[1], v: unquote(m[2]), secret: isSecretKey(m[1]) };
    });
    return { kind: 'fields', rule: 'env', fields };
  }

  // 3 · every line is `key: value` (2+ lines)
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length >= 2 && nonEmpty.every((l) => YAML_LINE.test(l.trim()) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(l.trim()))) {
    const fields = nonEmpty.map((l) => {
      const m = YAML_LINE.exec(l.trim())!;
      return { k: m[1].trim(), v: unquote(m[2] ?? ''), secret: isSecretKey(m[1]) };
    });
    return { kind: 'fields', rule: 'yaml', fields };
  }

  // 4 · one URL with credentials
  if (nonEmpty.length === 1) {
    const m = URL_CREDS.exec(nonEmpty[0].trim());
    if (m) {
      const dec = (s: string) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      };
      return {
        kind: 'fields', rule: 'url', fields: [
          { k: 'Host', v: m[4], secret: false },
          { k: 'Username', v: dec(m[2]), secret: false },
          { k: 'Password', v: dec(m[3]), secret: true },
          { k: 'Type', v: m[1].toLowerCase(), secret: false },
        ],
      };
    }
  }

  // 5 · two lines: identity, then secret
  if (nonEmpty.length === 2) {
    const [id, secret] = nonEmpty.map((l) => l.trim());
    if (!/\s/.test(id) && id.length <= 128 && !/\s/.test(secret) && (EMAIL.test(id) || looksLikePassword(secret))) {
      return { kind: 'fields', rule: 'pair', fields: [{ k: 'Username', v: id, secret: false }, { k: 'Password', v: secret, secret: true }] };
    }
  }

  // 6 · anything else
  return { kind: 'note', text: raw };
}
