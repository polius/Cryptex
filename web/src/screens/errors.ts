/** API error codes → copy (copy/en.json → errors). */
import { ApiError } from '../api/client';
import { bytes, shortDuration } from '../lib/format';
import { has, t } from '../lib/i18n';
import { config } from '../lib/state';

export function errorText(e: unknown, sender = 'the sender'): string {
  if (!(e instanceof ApiError)) {
    if ((e as Error)?.message === 'tampered') return t('errors.tampered', { sender });
    return t('errors.internal');
  }
  const brand = config.value?.brand.name || 'this server';
  switch (e.code) {
    case 'rate_limited': {
      const s = e.retryAfter ?? (e.resetAt ? (Date.parse(e.resetAt) - Date.now()) / 1000 : 60);
      return t('errors.rate_limited', { duration: shortDuration(s) });
    }
    case 'too_large':
      return t('errors.too_large', { limit: bytes(e.limit ?? 0) });
    case 'limit_exceeded':
      return e.message && !e.message.startsWith('That’s over') ? e.message : t('errors.limit_exceeded', { limit: e.limit ?? '' });
    case 'wrong_passphrase':
      return t('errors.wrong_passphrase', { tries: e.triesLeft ?? 0, sender });
    case 'wrong_code':
      return t('errors.wrong_code', { tries: e.triesLeft ?? 0 });
    case 'sign_in_required':
      return t('errors.sign_in_required', { brand });
    case 'invalid':
    case 'forbidden':
      return e.message && e.message !== 'invalid' ? e.message : t(`errors.${e.code}`);
    default:
      return has(`errors.${e.code}`) ? t(`errors.${e.code}`, { sender, brand }) : t('errors.internal');
  }
}
