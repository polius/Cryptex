/** Every paste rule, plus Windows line endings, trailing spaces, empty values and duplicate keys. */
import { describe, expect, it } from 'vitest';
import { hasCredentials, isPasswordKey, isSecretKey, parsePaste } from './paste';

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

  it('2 · escapes in double quotes are read in one pass', () => {
    expect(parsePaste('PASSWORD="a\\\\nb"')).toMatchObject({ fields: [{ v: 'a\\nb' }] }); // \\ then n: a backslash and an n
    expect(parsePaste('PASSWORD="a\\nb"')).toMatchObject({ fields: [{ v: 'a\nb' }] }); // \n: a new line
    expect(parsePaste('PASSWORD="say \\"hi\\" \\\\"')).toMatchObject({ fields: [{ v: 'say "hi" \\' }] });
    expect(parsePaste("PASSWORD='a\\nb'")).toMatchObject({ fields: [{ v: 'a\\nb' }] }); // single quotes: as typed
  });

  it('2 · an unquoted value ends at an inline comment', () => {
    expect(parsePaste('PORT=5432 # default')).toMatchObject({ fields: [{ k: 'PORT', v: '5432' }] });
  });

  it('2 · a secret keeps a "#" that would end another value (C7)', () => {
    expect(parsePaste('PASSWORD=abc #123')).toMatchObject({ fields: [{ k: 'PASSWORD', v: 'abc #123', secret: true }] });
    expect(parsePaste('host: db\npassword: abc # x')).toMatchObject({ fields: [{ v: 'db' }, { v: 'abc # x', secret: true }] });
    expect(parsePaste('PORT=5432 # default\nPIN=12 #34')).toMatchObject({ fields: [{ v: '5432' }, { v: '12 #34', secret: true }] });
  });

  it('2, 3 · a value holding credentials is secret whatever its name', () => {
    expect(parsePaste('url: https://u:p@h\nuser: x')).toMatchObject({ fields: [{ k: 'url', secret: true }, { k: 'user', secret: false }] });
    expect(parsePaste('DATABASE_URL=postgres://h/db?sslmode=require&password=zzz')).toMatchObject({ fields: [{ secret: true }] });
    expect(parsePaste('HOMEPAGE=https://example.com/?q=1')).toMatchObject({ fields: [{ secret: false }] });
    expect(hasCredentials('https://h/x?api_key=1')).toBe(true);
    expect(hasCredentials('https://h/x?page=1')).toBe(false);
  });

  it('3 · key: value lines (2+)', () => {
    expect(parsePaste('host: db\npassword: hunter2')).toEqual({
      kind: 'fields', rule: 'yaml', fields: [{ k: 'host', v: 'db', secret: false }, { k: 'password', v: 'hunter2', secret: true }],
    });
  });

  it('3 · names in any language, and a full-width colon (F5)', () => {
    expect(parsePaste('Логин: ivan\nПароль: hunter2')).toEqual({
      kind: 'fields', rule: 'yaml', fields: [{ k: 'Логин', v: 'ivan', secret: false }, { k: 'Пароль', v: 'hunter2', secret: true }],
    });
    expect(parsePaste('Usuario: ana\nContraseña: hunter2')).toMatchObject({ rule: 'yaml', fields: [{ secret: false }, { k: 'Contraseña', secret: true }] });
    expect(parsePaste('Kullanıcı: ali\nŞifre: hunter2')).toMatchObject({ rule: 'yaml', fields: [{ k: 'Kullanıcı' }, { k: 'Şifre', secret: true }] });
    expect(parsePaste('ユーザー名：taro\nパスワード：hunter2')).toMatchObject({ rule: 'yaml', fields: [{ v: 'taro' }, { k: 'パスワード', v: 'hunter2', secret: true }] });
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

  it('4 · secret query parameters become secret fields of their own', () => {
    expect(parsePaste('postgres://u:p@h/db?sslmode=require&password=z%26z')).toEqual({
      kind: 'fields', rule: 'url', fields: [
        { k: 'Host', v: 'h/db?sslmode=require', secret: false }, { k: 'Username', v: 'u', secret: false },
        { k: 'Password', v: 'p', secret: true }, { k: 'Type', v: 'postgres', secret: false }, { k: 'password', v: 'z&z', secret: true },
      ],
    });
    expect(parsePaste('redis://u:p@h:6379/0?token=t')).toMatchObject({ fields: [{ v: 'h:6379/0' }, {}, {}, {}, { k: 'token', v: 't', secret: true }] });
  });

  it('4 · percent-encoded credentials are decoded', () => {
    expect(parsePaste('mysql://us%40er:p%23ss@h/db')).toMatchObject({ fields: [{}, { v: 'us@er' }, { v: 'p#ss' }, { v: 'mysql' }] });
  });

  it('4 · a password holding "@" is split at the last one', () => {
    expect(parsePaste('postgres://app:p@ss@db:5432/x')).toMatchObject({
      rule: 'url', fields: [{ v: 'db:5432/x' }, { v: 'app' }, { v: 'p@ss' }, { v: 'postgres' }],
    });
  });

  it('4 · a URL without credentials is a note', () => {
    expect(parsePaste('https://example.com/a').kind).toBe('note');
    expect(parsePaste('https://example.com:8080/a?q=a@b').kind).toBe('note');
  });

  it('4 · the host part ends at the first "/", "?" or "#": an "@" in the query isn\'t the password\'s (F5)', () => {
    expect(parsePaste('postgres://app:pw@db:5432/x?sslmode=require&application_name=ops@acme')).toMatchObject({
      rule: 'url', fields: [{ k: 'Host', v: 'db:5432/x?sslmode=require&application_name=ops@acme' }, { v: 'app' }, { v: 'pw', secret: true }, { v: 'postgres' }],
    });
  });

  it('4 · a "+" in a value is a "+", not a space (F5)', () => {
    expect(parsePaste('postgres://u:p+q@h/db?sslpassword=Ab+cd%2B&x=1')).toMatchObject({
      fields: [{ v: 'h/db?x=1' }, { v: 'u' }, { v: 'p+q' }, { v: 'postgres' }, { k: 'sslpassword', v: 'Ab+cd+', secret: true }],
    });
  });

  it('4 · an empty user, and a URL whose only secret is in its query, are fields too (F5)', () => {
    expect(parsePaste('redis://:pw@host:6379')).toEqual({
      kind: 'fields', rule: 'url', fields: [
        { k: 'Host', v: 'host:6379', secret: false }, { k: 'Password', v: 'pw', secret: true }, { k: 'Type', v: 'redis', secret: false },
      ],
    });
    expect(parsePaste('https://api.example.com/hook?token=SECRETabc&v=2')).toEqual({
      kind: 'fields', rule: 'url', fields: [
        { k: 'Host', v: 'api.example.com/hook?v=2', secret: false }, { k: 'Type', v: 'https', secret: false }, { k: 'token', v: 'SECRETabc', secret: true },
      ],
    });
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

describe('secret field names in the 17 languages', () => {
  it('knows the words for password, secret, key and token', () => {
    const names = [
      'Contraseña', 'clave API', 'Secreto', 'Contrasenya', 'Clau', 'Mot de passe', 'mdp', 'Clé', 'cle', 'Jeton', 'Passwort',
      'Kennwort', 'Geheimnis', 'Schlüssel', 'schluessel', "Parola d'ordine", 'Segreto', 'Chiave', 'Senha', 'Segredo', 'Chave',
      'Wachtwoord', 'Geheim', 'Sleutel', 'Toegangscode', 'Hasło', 'haslo', 'Sekret', 'Klucz', 'Şifre', 'ŞİFRE', 'Wi-Fi şifresi',
      'sifre', 'Parola', 'Gizli', 'Anahtar', 'Belirteç', 'Пароль', 'Секрет', 'секретный ключ', 'Ключ API', 'Токен', 'ПИН',
      'पासवर्ड', 'कुंजी', 'गुप्त', 'टोकन', 'Sandi', 'Kata sandi', 'Rahasia', 'Kunci', 'パスワード', '暗証番号', 'シークレット', '秘密',
      '秘密鍵', 'APIキー', '鍵', 'キー', 'トークン', '密码', '数据库密码', '口令', '密钥', '秘钥', '令牌', '私钥', '비밀번호', '암호', '시크릿',
      'API 키', '토큰', 'DB_SENHA', 'db-wachtwoord',
    ];
    for (const n of names) expect(isSecretKey(n), n).toBe(true);
  });

  it('knows PINs, one-time codes, card codes and recovery phrases (C7)', () => {
    for (const n of ['PIN', 'pin code', 'SIM_PIN', 'ПИН', 'ПІН', 'Гасло', 'OTP', 'otp_secret', 'TOTP', 'CVV', 'cvc', 'seed phrase', 'Seed_Phrase',
      'mnemonic', 'recovery phrase', 'Recovery code']) {
      expect(isSecretKey(n), n).toBe(true);
    }
  });

  it('offers Generate for password and secret fields in every language (X-P10)', () => {
    for (const n of ['Password', 'db_pwd', 'API secret', 'Contraseña', 'Mot de passe', 'mdp', 'Passwort', 'Wachtwoord', 'Hasło', 'Şifre',
      'Пароль', 'Гасло', 'पासवर्ड', 'Kata sandi', 'パスワード', '密码', '비밀번호', 'Senha', 'Secreto']) {
      expect(isPasswordKey(n), n).toBe(true);
    }
    for (const n of ['Host', 'Username', 'API key', 'Token', 'PIN', 'Clé', 'Schlüssel', 'Ключ']) expect(isPasswordKey(n), n).toBe(false);
  });

  it('matches short words only as whole words', () => {
    for (const n of ['Clear', 'Cleaner', 'Clause', 'пингвин', 'Sandiwara', 'キーボード', '鍵盤', '키보드', 'Host', 'Username', 'Пользователь', '用户名',
      'Spin', 'Pinned', 'Opinion', 'Hotpot', 'Cvvx']) {
      expect(isSecretKey(n), n).toBe(false);
    }
  });
});
