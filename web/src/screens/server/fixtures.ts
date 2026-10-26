/** Sample data for the demo's read-only tour of the Server tab (permissions.md rule 4). */
const now = Date.now();
const ago = (m: number) => new Date(now - m * 60_000).toISOString();

const recent = [
  { id: 7, type: 'secret.revealed', at: ago(4), detail: { views_left: 0, access_check: 'email' }, actor: 'link', actor_email: null, item: 'k7Qp2vR9mL', item_kind: 'secret' },
  { id: 6, type: 'secret.created', at: ago(8), detail: { views: 1, expires_in: 86400, access: 'email', passphrase: false, files: 0 }, actor: 'user', actor_email: 'sam@acme.example', item: 'k7Qp2vR9mL', item_kind: 'secret' },
  { id: 5, type: 'request.answered', at: ago(150), detail: { size: 812 }, actor: 'link', actor_email: null, item: '7hk2Vn4pXa', item_kind: 'request' },
  { id: 4, type: 'setting.changed', at: ago(300), detail: { key: 'max_expiration', from: 86400, to: 604800 }, actor: 'user', actor_email: 'sam@acme.example', item: null, item_kind: null },
  { id: 3, type: 'user.signed_in', at: ago(302), detail: { method: 'oidc' }, actor: 'user', actor_email: 'sam@acme.example', item: null, item_kind: null },
  { id: 2, type: 'secret.passphrase_failed', at: ago(1200), detail: { tries_left: 2 }, actor: 'link', actor_email: null, item: 'p2Lx8sWq0c', item_kind: 'secret' },
  { id: 1, type: 'token.created', at: ago(1500), detail: { token_id: 'x', scopes: ['send'] }, actor: 'user', actor_email: 'sam@acme.example', item: null, item_kind: null },
];

export const FIXTURES = {
  '/server/overview': {
    version: '3.0.0', update_available: null, public_url: 'https://vault.acme.example',
    storage: { used: 1.2 * 1024 ** 3, disk_total: 50 * 1024 ** 3, disk_free: 38 * 1024 ** 3 },
    live: { secrets: 14, requests: 3, expiring_today: 3 }, week: { created: 126, senders: 18 },
    cleanup: { last_run: ago(2), removed: 9 },
    attention: [{ code: 'smtp', level: 'warn' }, { code: '2fa', level: 'warn', n: 1, emails: ['dana@acme.example'] }],
    recent: recent.slice(0, 3),
  },
  '/server/access': {
    mode: 'signed_in', locked_by: null, sso: { enabled: true, name: 'Google Workspace', issuer: 'accounts.google.com', domains: ['acme.example'] },
    people: [
      { id: 'u1', email: 'sam@acme.example', name: 'Sam Rivera', role: 'owner', mfa: true, sign_in: 'sso', last_seen_at: ago(3) },
      { id: 'u2', email: 'dana@acme.example', name: 'Dana Kim', role: 'owner', mfa: false, sign_in: 'password', last_seen_at: ago(900) },
      { id: 'u3', email: 'lee@acme.example', name: 'Lee Park', role: 'member', mfa: false, sign_in: 'sso', last_seen_at: ago(60) },
    ],
    me: 'u1', reauth_until: null,
  },
  '/server/limits': {
    disk_free: 38 * 1024 ** 3,
    items: {
      max_expiration: { value: 604800, locked_by: null, min: 300, max: 31536000 }, max_views: { value: 10, locked_by: null, min: 1, max: 100 },
      max_file_size: { value: 100 * 1024 ** 2, locked_by: null, min: 1024, max: 10 * 1024 ** 3 }, max_files: { value: 5, locked_by: null, min: 0, max: 20 },
      max_message_length: { value: 10000, locked_by: 'MAX_MESSAGE_LENGTH', min: 100, max: 1000000 },
      request_max_expiration: { value: 2592000, locked_by: null, min: 300, max: 31536000 }, request_max_keep: { value: 2592000, locked_by: null, min: 300, max: 31536000 },
      audit_retention_days: { value: 365, locked_by: null, min: 1, max: 3650 },
    },
  },
  '/server/branding': { name: 'Acme', logo_url: null, public_url: 'https://vault.acme.example', name_locked_by: null, public_url_locked_by: 'PUBLIC_URL', logo_name: null },
  '/server/notifications': {
    smtp: { enabled: false, host: null, port: null, from: null, tls: null },
    webhooks: [{ id: 'w1', url: 'https://hooks.slack.com/services/T0A1/B0C2/xxxx', events: ['*'], created_at: ago(5000), last_status: 200, last_error: null, last_attempt_at: ago(4), pending: 0 }],
    event_types: ['secret.created', 'secret.revealed', 'secret.destroyed', 'request.answered'],
  },
  '/server/tokens': {
    items: [
      { id: 't1', name: 'CI deploys', scopes: ['send'], created_at: ago(9000), expires_at: new Date(now + 80 * 86400_000).toISOString(), last_used_at: ago(120), hint: 'cx_live_…7Q2a', owner: { id: 'u1', email: 'sam@acme.example', name: 'Sam Rivera' } },
      { id: 't2', name: 'Laptop CLI', scopes: ['send', 'request'], created_at: ago(20000), expires_at: new Date(now + 60 * 86400_000).toISOString(), last_used_at: ago(1440), hint: 'cx_live_…k9Px', owner: { id: 'u2', email: 'dana@acme.example', name: 'Dana Kim' } },
    ],
  },
  '/server/audit': { items: recent, next: null },
};
