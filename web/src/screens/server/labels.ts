/** Human text for audit events (E1 recent events, E7 audit log). Events never hold content. */
import { bytes, duration, num } from '../../lib/format';
import { LOCALE, t } from '../../lib/i18n';

export interface AuditRow {
  id: number;
  type: string;
  at: string;
  detail: Record<string, unknown>;
  actor: 'user' | 'link' | 'system';
  actor_username: string | null;
  item: string | null;
}

/** Settings that have a name in the copy deck (events.key_<setting>); others show their raw key. */
const KEY_NAMES = new Set([
  'max_expiration', 'max_file_size', 'max_files', 'max_message_length',
  'audit_retention_days', 'access', 'brand_name', 'brand_logo',
]);

/** Limits in the units the Limits page uses; a logo is only ever "uploaded" (the event holds no file name). */
function settingValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    if (/expiration/.test(key)) return duration(v);
    if (key === 'max_file_size') return bytes(v);
    if (key === 'max_files') return t('limits.n_files', { n: v });
    if (key === 'max_message_length') return t('limits.n_characters', { n: v });
    if (key === 'audit_retention_days') return t('limits.n_days', { n: v });
    return num(v);
  }
  if (key === 'brand_logo') return t('events.value_uploaded');
  if (key === 'access') return v === 'anyone' ? t('events.value_anyone') : t('events.value_signed_in');
  return String(v);
}

export function eventText(e: Pick<AuditRow, 'type' | 'detail'>): string {
  const d = e.detail as Record<string, never>;
  switch (e.type) {
    case 'secret.created': {
      const parts = [d.views === 1 ? t('events.part_once') : t('events.part_until_expiry'), duration(Number(d.expires_in))];
      if (d.passphrase) parts.push(t('events.part_passphrase'));
      if (Number(d.files)) parts.push(t('events.part_files', { n: Number(d.files) }));
      return t('events.created', { details: new Intl.ListFormat(LOCALE, { type: 'unit', style: 'short' }).format(parts) });
    }
    case 'secret.revealed':
      return d.views_left === 0 ? t('events.revealed_destroyed') : t('events.revealed_still_works'); // one-time, or until it expires
    case 'secret.passphrase_failed':
      return t('events.passphrase_failed', { n: Number(d.tries_left) });
    case 'secret.destroyed':
      return d.reason === 'too_many_tries' ? t('events.destroyed_tries') : d.reason === 'reported' ? t('events.destroyed_reported') : t('events.destroyed_sender');
    case 'secret.requested':
      return t('events.requested', { duration: duration(Number(d.expires_in)) });
    case 'secret.request_answered':
      return t('events.request_answered');
    case 'secret.expired':
      return Number(d.views_used) ? t('events.expired') : t('events.expired_unopened');
    case 'user.signed_in':
      return t('events.signed_in');
    case 'user.invited':
      return d.reset ? t('events.invite_reset') : t('events.invited', { role: d.role });
    case 'user.joined':
      return t('events.joined');
    case 'user.temp_password':
      return t('events.temp_password');
    case 'user.password_reset':
      return d.via === 'link' ? t('events.password_reset_link') : t('events.password_reset');
    case 'user.reset_link':
      return d.lock ? t('events.reset_link_locked') : t('events.reset_link');
    case 'user.reset_cancelled':
      return t('events.reset_cancelled');
    case 'user.removed':
      return t('events.removed', { role: d.role });
    case 'user.sign_in_failed':
      return d.method === 'totp' ? t('events.sign_in_failed_totp') : d.method === 'reset_code' ? t('events.sign_in_failed_reset_code') : t('events.sign_in_failed_password');
    case 'user.password_changed':
      return t('events.password_changed');
    case 'user.totp_on':
      return t('events.totp_on');
    case 'user.totp_off':
      return t('events.totp_off');
    case 'user.role_changed':
      return t('events.role_changed', { role: d.role });
    case 'setting.changed': {
      const key = String(d.key);
      return t('events.setting_changed', { name: KEY_NAMES.has(key) ? t(`events.key_${key}`) : key, from: settingValue(key, d.from), to: settingValue(key, d.to) });
    }
    case 'setup.completed':
      return t('events.setup_completed');
    case 'demo.breaker_tripped':
      return t('events.demo_breaker', { rule: d.rule });
    default:
      return e.type;
  }
}

export function actorText(e: AuditRow): string {
  if (e.actor === 'link') return t('server.link_holder');
  if (e.actor === 'system') return t('events.actor_system');
  return e.actor_username ?? t('events.actor_someone');
}

/** Audit log filter groups; `label` is a copy key. */
export const EVENT_GROUPS: Array<{ value: string; label: string }> = [
  { value: '', label: 'events.group_all' },
  { value: 'secret.*', label: 'events.group_links' },
  { value: 'user.*', label: 'events.group_people' },
  { value: 'setting.changed', label: 'events.group_settings' },
];
