/** Your links: local receipts + server statuses (lookup, account sync) + live updates over SSE. */
import { api, type Receipt } from '../../api/client';
import { config, linksCount } from '../../lib/state';
import { receipts, requestKeys, type StoredReceipt } from '../../store/db';

export interface Row {
  local: StoredReceipt | null;
  remote: Receipt | null;
  kind: 'secret' | 'request';
  id: string;
}

export const isFinal = (r: Row): boolean => {
  const s = r.remote?.status ?? r.local?.last_status;
  if (s === 'opened') return r.kind === 'secret' && (r.remote?.views_left ?? 0) <= 0;
  return s === 'expired' || s === 'destroyed' || s === 'cancelled' || s === 'revealed';
};

export const needsYou = (r: Row): boolean => (r.remote?.status ?? r.local?.last_status) === 'answered';

const THIRTY_DAYS = 30 * 86400_000;

/** Load local receipts, ask the server for their statuses, merge account receipts, persist changes. */
export async function loadRows(): Promise<Row[]> {
  const local = await receipts.all().catch(() => [] as StoredReceipt[]);
  const byKey = new Map<string, Row>(local.map((l) => [`${l.kind}:${l.id}`, { local: l, remote: null, kind: l.kind, id: l.id }]));
  const live = local.filter((l) => !l.ended_at || Date.now() - Date.parse(l.ended_at) < THIRTY_DAYS);
  if (live.length) {
    const r = await api<{ items: Receipt[] }>('POST', '/receipts/lookup', {
      body: { items: live.slice(0, 200).map((l) => ({ id: l.id, manage_token: l.manage_token })) },
    }).catch(() => ({ items: [] as Receipt[] }));
    for (const rec of r.items) {
      const row = byKey.get(`${rec.kind}:${rec.id}`);
      if (row) row.remote = rec;
    }
  }
  if (config.value?.signed_in) {
    const mine = await api<{ items: Receipt[] }>('GET', '/me/receipts').catch(() => ({ items: [] as Receipt[] }));
    for (const rec of mine.items) {
      const key = `${rec.kind}:${rec.id}`;
      const row = byKey.get(key);
      if (row) row.remote = row.remote ?? rec;
      else byKey.set(key, { local: null, remote: rec, kind: rec.kind, id: rec.id });
    }
  }
  const rows = [...byKey.values()];
  for (const row of rows) await persist(row);
  // Drop receipts 30 days after a final status, and request keys with them.
  for (const row of rows) {
    if (row.local?.ended_at && Date.now() - Date.parse(row.local.ended_at) > THIRTY_DAYS) {
      await receipts.remove(row.kind, row.id);
      if (row.kind === 'request') await requestKeys.remove(row.id);
    }
  }
  linksCount.value = rows.filter((r) => !isFinal(r)).length;
  return rows.sort((a, b) => (created(b) || '').localeCompare(created(a) || ''));
}

export const created = (r: Row) => r.local?.created_at ?? r.remote?.created_at ?? r.remote?.ended_at ?? '';

/** Keep the local copy current; delete the stored link (with its key) once the status is final. */
export async function persist(row: Row): Promise<void> {
  if (!row.local || !row.remote) return;
  const status = row.remote.status;
  const patch: Partial<StoredReceipt> = {};
  if (status !== row.local.last_status) patch.last_status = status;
  const opened = row.remote.events?.find((e) => e.type === 'secret.revealed')?.at;
  if (opened && !row.local.opened_at) patch.opened_at = opened;
  if (isFinal(row)) {
    if (row.local.link) patch.link = undefined;
    if (!row.local.ended_at) patch.ended_at = row.remote.ended_at ?? new Date().toISOString();
  }
  if (Object.keys(patch).length) {
    row.local = { ...row.local, ...patch };
    await receipts.put(row.local);
  }
}

export async function refreshLinksCount(): Promise<void> {
  try {
    const all = await receipts.all();
    linksCount.value = all.filter((r) => !['opened', 'expired', 'destroyed', 'cancelled', 'revealed'].includes(r.last_status) || (r.kind === 'secret' && r.last_status === 'opened' && (r.views ?? 1) > 1 && !r.ended_at)).length;
  } catch {
    linksCount.value = 0;
  }
}

/** Live updates: one EventSource for everything on the page. Returns a stop function. */
export function subscribe(rows: Row[], onEvent: (data: { kind: string; id: string; status: string; views_left?: number }) => void): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  const items = rows.filter((r) => r.local && !isFinal(r)).map((r) => ({ id: r.id, manage_token: r.local!.manage_token }));
  if (!items.length && !config.value?.signed_in) return () => undefined;
  (async () => {
    try {
      const { ticket } = await api<{ ticket: string }>('POST', '/receipts/subscribe', { body: { items } });
      if (stopped) return;
      es = new EventSource(`/api/v1/receipts/events?ticket=${encodeURIComponent(ticket)}`);
      es.addEventListener('receipt', (e) => onEvent(JSON.parse((e as MessageEvent).data)));
    } catch {
      /* statuses still refresh on load */
    }
  })();
  return () => {
    stopped = true;
    es?.close();
  };
}
