/** API errors → copy (copy/en.json → errors). The API's English `message` is never shown: the words come from
 *  the error's code, plus its field and reason for `invalid` and `limit_exceeded`, with errors.<code> as the fallback. */
import { ApiError } from '../api/client';
import { bytes, duration, shortDuration } from '../lib/format';
import { has, t } from '../lib/i18n';
import { config } from '../lib/state';

/** `invalid` by field (the body field, header or setting the server named). */
const INVALID: Record<string, string> = {
  setup_code: 'errors.setup_code',
  totp_code: 'errors.totp_code',
  current: 'errors.current_password',
  username: 'errors.username_taken',
  'X-PoW': 'errors.pow',
  logo: 'errors.logo',
  user_id: 'errors.stale', // people changed in another tab: joined, removed, or it's you
  mode: 'errors.locked', // fixed choices: only an environment variable can refuse them
  name: 'errors.locked',
  max_expiration: 'errors.out_of_range',
  max_file_size: 'errors.out_of_range',
  max_files: 'errors.out_of_range',
  max_message_length: 'errors.out_of_range',
  audit_retention_days: 'errors.out_of_range',
  from: 'errors.date', // the audit log's time range
  to: 'errors.date',
};

/** `forbidden` by reason. */
const FORBIDDEN: Record<string, string> = {
  csrf: 'errors.csrf',
  setup_needed: 'errors.setup_needed',
  last_owner: 'errors.last_owner',
};

function invalidText(e: ApiError): string {
  if (e.reason === 'locked') return t('errors.locked');
  const key = e.field ? INVALID[e.field] : undefined;
  return t(key ?? 'errors.invalid');
}

function limitText(e: ApiError): string {
  const f = e.field ?? '';
  if (f === 'streams') return e.limit === 0 ? t('errors.files_paused') : t('send.max_files', { n: e.limit ?? 0 });
  if (/^streams\[\d+\]\.size$/.test(f)) return e.limit ? t('errors.too_large', { limit: bytes(e.limit) }) : t('errors.too_large_plain');
  if (f === 'policy.expires_in' && e.limit) return t('errors.limit_expiry', { duration: duration(e.limit) });
  if (!f && e.limit) return t('errors.vault_full'); // Your links (the account vault) is full
  return t('errors.limit_exceeded', { limit: e.limit ?? '' });
}

export function errorText(e: unknown, sender = t('errors.sender_fallback')): string {
  if (!(e instanceof ApiError)) {
    const m = (e as Error)?.message;
    if (m === 'tampered') return t('errors.tampered', { sender });
    if (m === 'weak_kdf') return t('errors.weak_kdf'); // store/vault.ts checkKdf
    if (m === 'locked') return t('errors.vault_locked');
    return t('errors.internal');
  }
  const brand = config.value?.brand.name || t('errors.brand_fallback');
  switch (e.code) {
    case 'rate_limited': {
      const s = e.retryAfter ?? (e.resetAt ? (Date.parse(e.resetAt) - Date.now()) / 1000 : NaN);
      if (e.reason === 'demo_full') return t('errors.demo_full');
      return Number.isFinite(s) && s > 0 ? t('errors.rate_limited', { duration: shortDuration(s) }) : t('errors.rate_limited_later');
    }
    case 'too_large':
      return e.limit ? t('errors.too_large', { limit: bytes(e.limit) }) : t('errors.too_large_plain');
    case 'limit_exceeded':
      return limitText(e);
    case 'wrong_passphrase':
      return t('errors.wrong_passphrase', { tries: e.triesLeft ?? 0, sender });
    case 'wrong_code':
      if (e.triesLeft === 0) return t('errors.wrong_code_last'); // the sign-in starts over from the password
      return e.triesLeft !== undefined ? t('errors.wrong_code', { tries: e.triesLeft }) : t('signin.wrong_code');
    case 'sign_in_required':
      return e.reason === 'expired' ? t('signin.expired') : t('errors.sign_in_required', { brand });
    case 'wrong_password':
      return e.field === 'current' ? t('errors.current_password') : t('errors.wrong_password');
    case 'invalid':
      return invalidText(e);
    case 'forbidden':
      if (e.reason && FORBIDDEN[e.reason]) return t(FORBIDDEN[e.reason]);
      return e.status === 409 ? t('errors.last_owner') : t('errors.forbidden');
    default:
      if (has(`errors.${e.code}`)) return t(`errors.${e.code}`, { sender, brand });
      return e.status === 507 ? t('errors.storage_full') : t('errors.internal');
  }
}
