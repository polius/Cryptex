/** Every row of frontend.md §5, plus Windows line endings, trailing spaces, empty values and duplicate keys. */
import { describe, expect, it } from 'vitest';
import { parsePaste } from './paste';

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\nAAAA\n-----END OPENSSH PRIVATE KEY-----';

describe('paste parser', () => {
  it('1 · one PEM block becomes a secret "Private key" field', () => {
    expect(parsePaste(KEY)).toEqual({ kind: 'fields', rule: 'pem', fields: [{ k: 'Private key', v: KEY, secret: true }] });
    expect(parsePaste('\n' + KEY + '\n\n')).toMatchObject({ rule: 'pem' });
  });

  it('1 · a certificate is a field but not secret', () => {
    const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect(parsePaste(cert)).toMatchObject({ rule: 'pem', fields: [{ k: 'Certificate', secret: false }] });
  });

  it('1 · two PEM blocks are not one block', () => {
    expect(parsePaste(KEY + '\n' + KEY).kind).toBe('note');
  });

  it('2 · .env lines, quotes removed, comments skipped', () => {
    expect(parsePaste('# staging\nDB_HOST=db\nDB_PASSWORD="x y"\nexport API_TOKEN=\'abc\'')).toEqual({
      kind: 'fields', rule: 'env', fields: [
        { k: 'DB_HOST', v: 'db', secret: false },
        { k: 'DB_PASSWORD', v: 'x y', secret: true },
        { k: 'API_TOKEN', v: 'abc', secret: true },
      ],
    });
  });

  it('2 · Windows line endings and trailing spaces', () => {
    expect(parsePaste('A=1  \r\nB=2\t\r\n')).toEqual({
      kind: 'fields', rule: 'env', fields: [{ k: 'A', v: '1', secret: false }, { k: 'B', v: '2', secret: false }],
    });
  });

  it('2 · empty values and duplicate keys are kept in order', () => {
    expect(parsePaste('KEY=\nKEY=two\nOTHER=')).toEqual({
      kind: 'fields', rule: 'env', fields: [
        { k: 'KEY', v: '', secret: true }, { k: 'KEY', v: 'two', secret: true }, { k: 'OTHER', v: '', secret: false },
      ],
    });
  });

  it('2 · an unquoted value ends at an inline comment', () => {
    expect(parsePaste('PORT=5432 # default')).toMatchObject({ fields: [{ k: 'PORT', v: '5432' }] });
  });

  it('3 · key: value lines (2+)', () => {
    expect(parsePaste('host: db\npassword: hunter2')).toEqual({
      kind: 'fields', rule: 'yaml', fields: [{ k: 'host', v: 'db', secret: false }, { k: 'password', v: 'hunter2', secret: true }],
    });
  });

  it('3 · a single key: value line stays a note', () => {
    expect(parsePaste('note: call me').kind).toBe('note');
  });

  it('4 · one URL with credentials', () => {
    expect(parsePaste('postgres://app:pw@db:5432/x')).toEqual({
      kind: 'fields', rule: 'url', fields: [
        { k: 'Host', v: 'db:5432/x', secret: false }, { k: 'Username', v: 'app', secret: false },
        { k: 'Password', v: 'pw', secret: true }, { k: 'Type', v: 'postgres', secret: false },
      ],
    });
  });

  it('4 · percent-encoded credentials are decoded', () => {
    expect(parsePaste('mysql://us%40er:p%23ss@h/db')).toMatchObject({ fields: [{}, { v: 'us@er' }, { v: 'p#ss' }, { v: 'mysql' }] });
  });

  it('4 · a URL without credentials is a note', () => {
    expect(parsePaste('https://example.com/a').kind).toBe('note');
  });

  it('5 · two lines: identity, then secret', () => {
    expect(parsePaste('sam@acme.example\nk7#Qp2-vR9mL')).toEqual({
      kind: 'fields', rule: 'pair', fields: [{ k: 'Username', v: 'sam@acme.example', secret: false }, { k: 'Password', v: 'k7#Qp2-vR9mL', secret: true }],
    });
    expect(parsePaste('app_rw\nCorrect-Horse-9')).toMatchObject({ rule: 'pair' });
  });

  it('5 · two plain words are not a login', () => {
    expect(parsePaste('hello\nworld').kind).toBe('note');
  });

  it('6 · anything else is one note, untouched', () => {
    const t = 'The wifi password is on the fridge.\nAsk Dana if it changed.';
    expect(parsePaste(t)).toEqual({ kind: 'note', text: t });
    expect(parsePaste('').kind).toBe('note');
  });
});
