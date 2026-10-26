/** Human text for audit events (E1 recent events, E7 audit log). Events never hold content. */
import { bytes, duration } from '../../lib/format';
import { t } from '../../lib/i18n';

export interface AuditRow {
  id: number;
  type: string;
  at: string;
  detail: Record<string, unknown>;
  actor: 'user' | 'link' | 'system' | 'token';
  actor_email: string | null;
  item: string | null;
  item_kind: 'secret' | 'request' | null;
}

const KEY_NAMES: Record<string, string> = {
  max_expiration: 'longest expiry', max_views: 'most opens', max_file_size: 'file size', max_files: 'files per link',
  max_message_length: 'message length', request_max_expiration: 'request link lifetime', request_max_keep: 'answer kept',
  audit_retention_days: 'audit retention', access: 'who can create links', brand_name: 'name', brand_logo: 'logo', public_url: 'address', webhook: 'webhook',
};

function settingValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (/expiration|keep/.test(key) && typeof v === 'number') return duration(v);
  if (key === 'max_file_size' && typeof v === 'number') return bytes(v);
  if (key === 'access') return v === 'anyone' ? 'anyone' : 'people who sign in';
  return String(v);
}

export function eventText(e: Pick<AuditRow, 'type' | 'detail'>): string {
  const d = e.detail as Record<string, never>;
  switch (e.type) {
    case 'secret.created': {
      const views = Number(d.views) === 1 ? 'opens once' : `opens ${d.views} times`;
      const who = d.access === 'email' ? ', one email' : d.access === 'org' ? ', org only' : '';
      return `Link created · ${views}, ${duration(Number(d.expires_in))}${who}${d.passphrase ? ', passphrase' : ''}${Number(d.files) ? `, ${d.files} file${Number(d.files) > 1 ? 's' : ''}` : ''}`;
    }
    case 'secret.revealed':
      return Number(d.views_left) === 0 ? 'Link revealed and destroyed' : `Link revealed · ${d.views_left} opens left`;
    case 'secret.passphrase_failed':
      return `Passphrase failed · ${d.tries_left} tries left`;
    case 'secret.code_sent':
      return 'Email code sent';
    case 'secret.code_failed':
      return `Wrong email code · ${d.tries_left} tries left`;
    case 'secret.destroyed':
      return d.reason === 'too_many_tries' ? 'Destroyed after too many wrong tries' : d.reason === 'reported' ? 'Removed after a report' : 'Link destroyed by the sender';
    case 'secret.expired':
      return Number(d.views_used) ? 'Link expired' : 'Link expired, never opened';
    case 'request.created':
      return `Request created · link ${duration(Number(d.expires_in))}, answer kept ${duration(Number(d.keep_answer_s))}`;
    case 'request.answered':
      return 'Request answered';
    case 'request.answer_read':
      return 'Answer opened by the requester';
    case 'request.cancelled':
      return 'Request cancelled';
    case 'request.expired':
      return d.answered ? 'Kept answer deleted' : 'Request expired without an answer';
    case 'user.signed_in':
      return d.method === 'oidc' ? 'Signed in with single sign-on' : 'Signed in with a password';
    case 'user.sign_in_failed':
      return d.method === 'totp' ? 'Sign-in failed · wrong 2FA code' : 'Sign-in failed · wrong password';
    case 'user.role_changed':
      return `Role changed to ${d.role}`;
    case 'token.created':
      return `API token created · ${(d.scopes as unknown as string[] | undefined)?.join(', ') ?? ''}`;
    case 'token.revoked':
      return 'API token revoked';
    case 'setting.changed': {
      const key = String(d.key);
      return `Setting changed · ${KEY_NAMES[key] ?? key} ${settingValue(key, d.from)} → ${settingValue(key, d.to)}`;
    }
    case 'setup.completed':
      return 'Setup finished';
    case 'webhook.failed':
      return `Webhook gave up after retries${d.status ? ` · HTTP ${d.status}` : ''}`;
    case 'demo.breaker_tripped':
      return `Demo breaker tripped · ${d.rule}`;
    default:
      return e.type;
  }
}

export function actorText(e: AuditRow): string {
  if (e.actor === 'link') {
    const check = (e.detail as { access_check?: string }).access_check;
    return t('server.link_holder') + (check === 'email' ? ' · email confirmed' : check === 'org' ? ' · signed in' : '');
  }
  if (e.actor === 'system') return 'System';
  return e.actor_email ? `${e.actor_email}${e.actor === 'token' ? ' (API token)' : ''}` : 'Someone';
}

export const EVENT_GROUPS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All events' },
  { value: 'secret.*', label: 'Links' },
  { value: 'request.*', label: 'Requests' },
  { value: 'user.*', label: 'Sign-in and roles' },
  { value: 'token.*', label: 'API tokens' },
  { value: 'setting.changed', label: 'Settings' },
];
