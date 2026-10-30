/** Sample data for the demo's read-only tour of the Server tab. */
const now = Date.now();
const ago = (m: number) => new Date(now - m * 60_000).toISOString();

const recent = [
  { id: 7, type: 'secret.revealed', at: ago(4), detail: { views_left: 0 }, actor: 'link', actor_username: null, item: 'k7Qp2vR9mL' },
  { id: 6, type: 'secret.created', at: ago(8), detail: { views: 1, expires_in: 86400, passphrase: true, files: 0 }, actor: 'user', actor_username: 'demo', item: 'k7Qp2vR9mL' },
  { id: 4, type: 'setting.changed', at: ago(300), detail: { key: 'max_expiration', from: 86400, to: 604800 }, actor: 'user', actor_username: 'demo', item: null },
  { id: 3, type: 'user.signed_in', at: ago(302), detail: {}, actor: 'user', actor_username: 'demo', item: null },
  { id: 2, type: 'secret.passphrase_failed', at: ago(1200), detail: { tries_left: 2 }, actor: 'link', actor_username: null, item: 'p2Lx8sWq0c' },
];

export const FIXTURES = {
  '/server/overview': {
    version: '3.0.0', update_available: null,
    storage: { used: 1.2 * 1024 ** 3, disk_total: 50 * 1024 ** 3, disk_free: 38 * 1024 ** 3 },
    live: { secrets: 14, expiring_today: 3 }, week: { created: 126, senders: 18 },
    cleanup: { last_run: ago(2), removed: 9 },
    attention: [],
    recent: recent.slice(0, 3),
  },
  '/server/access': {
    mode: 'signed_in', locked_by: null,
    people: [
      { id: 'u1', username: 'demo', role: 'owner', status: 'active', invite_expires_at: null, last_seen_at: ago(3) },
      { id: 'u2', username: 'dana', role: 'owner', status: 'active', invite_expires_at: null, last_seen_at: ago(900) },
      { id: 'u3', username: 'lee', role: 'member', status: 'active', invite_expires_at: null, last_seen_at: ago(60) },
      { id: 'u4', username: 'ana', role: 'member', status: 'invited', invite_expires_at: new Date(now + 5 * 86_400_000).toISOString(), last_seen_at: null },
    ],
    me: 'u1', reauth_until: null,
  },
  '/server/limits': {
    disk_free: 38 * 1024 ** 3,
    items: {
      max_expiration: { value: 604800, locked_by: null, min: 300, max: 31536000 },
      max_file_size: { value: 100 * 1024 ** 2, locked_by: null, min: 1024, max: null }, max_files: { value: 5, locked_by: null, min: 0, max: null },
      max_message_length: { value: 10000, locked_by: null, min: 100, max: null },
      audit_retention_days: { value: 365, locked_by: null, min: 1, max: 3650 },
    },
  },
  '/server/branding': { name: '', logo_url: null, name_locked_by: null, logo_name: null },
  '/server/audit': { items: recent, next: null },
};
