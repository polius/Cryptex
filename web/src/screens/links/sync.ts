/** Your links: local receipts + server statuses (lookup, account sync), read again while the page is open. */
import { useEffect, useRef } from 'preact/hooks';
import { api, ApiError, signedInUid, type Receipt } from '../../api/client';
import { closeRequest, lookupRequests } from '../../flows/request';
import { destroySecret } from '../../flows/send';
import { setLinksCount } from '../../lib/state';
import { receipts, type StoredReceipt } from '../../store/db';
import { vaultItems } from '../../store/vault';

export interface Row {
  local: StoredReceipt | null;
  remote: Receipt | null;
  id: string;
}

/** A request ("Ask for a secret") rather than a link that was sent. */
export const isRequest = (r: Row): boolean => r.local?.kind === 'request' || r.remote?.kind === 'request';

/** A link that opens any number of times until it expires (not a one-time link). */
export const opensUntilExpiry = (r: Row): boolean => (r.remote && r.remote.max_views !== undefined ? r.remote.max_views : r.local?.views) === null;

export const isFinal = (r: Row): boolean => {
  const s = r.remote?.status ?? r.local?.last_status;
  if (s === 'opened') return !opensUntilExpiry(r) && (r.remote?.views_left ?? 0) <= 0;
  return s === 'expired' || s === 'destroyed' || s === 'gone';
};

const THIRTY_DAYS = 30 * 86400_000;

/** Writes to the stored links, one at a time: a status read that started before a delete must not write the deleted
 *  link back when it ends. */
let writing: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(write: () => Promise<T>): Promise<T> {
  const run = writing.then(write, write);
  writing = run.catch(() => undefined);
  return run;
}

/** Store a newer copy of a link, unless it was deleted meanwhile. */
const update = (r: StoredReceipt) => oneAtATime(async () => {
  if (await receipts.get(r.id)) await receipts.put(r);
});
/** The most IDs one /receipts/lookup takes. */
export const BATCH = 2000;

/** Every receipt synced to the account (GET /me/receipts, a page at a time). */
async function accountReceipts(): Promise<Receipt[]> {
  const out: Receipt[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: Receipt[]; next?: string | null } = await api('GET', `/me/receipts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...page.items);
    cursor = page.next && page.next !== cursor ? page.next : null;
  } while (cursor);
  return out;
}

/** Load local receipts, ask the server for their statuses, merge account receipts, persist changes. Throws when
 *  the list itself can't be read (the account's vault or receipts: offline, 5xx, locked), so Your links says so
 *  instead of showing nothing, or showing the account's links as sent from another device. */
export async function loadRows(): Promise<Row[]> {
  const local = await receipts.all();
  const byId = new Map<string, Row>(local.map((l) => [l.id, { local: l, remote: null, id: l.id }]));
  const live = local.filter((l) => l.kind !== 'request' && (!l.ended_at || Date.now() - Date.parse(l.ended_at) < THIRTY_DAYS));
  const looked = new Set<string>(); // ids the server answered about
  for (let i = 0; i < live.length; i += BATCH) {
    const asked = live.slice(i, i + BATCH);
    try {
      const r = await api<{ items: Receipt[] }>('POST', '/receipts/lookup', {
        body: { items: asked.map((l) => ({ id: l.id, manage_token: l.manage_token })) },
      });
      for (const l of asked) looked.add(l.id);
      for (const rec of r.items) {
        const row = byId.get(rec.id);
        if (row) row.remote = rec;
      }
    } catch {
      break; // offline or rate limited: keep the stored statuses
    }
  }
  if (signedInUid()) {
    for (const rec of await accountReceipts()) {
      const row = byId.get(rec.id);
      if (row) row.remote = row.remote ?? rec;
      else byId.set(rec.id, { local: null, remote: rec, id: rec.id });
    }
  }
  // Requests: the same, proven with their manage tokens.
  const asked = local.filter((l) => l.kind === 'request' && !l.ended_at);
  for (let i = 0; i < asked.length; i += BATCH) {
    const part = asked.slice(i, i + BATCH);
    try {
      for (const rec of await lookupRequests(part)) {
        const row = byId.get(rec.id);
        if (row) row.remote = rec;
      }
      for (const l of part) looked.add(l.id);
    } catch {
      break; // offline or rate limited: keep the stored statuses
    }
  }
  const rows = [...byId.values()];
  // The server answered but doesn't know these any more (data wiped, or ended long ago): they're gone.
  // Keeping the stored copies current is best effort: the list is shown either way.
  const keep = (p: Promise<void>) => p.catch(() => undefined);
  for (const row of rows) {
    if (looked.has(row.id) && !row.remote && row.local && !row.local.ended_at) {
      row.local = { ...row.local, last_status: 'gone', link: undefined, ended_at: new Date().toISOString() };
      await keep(update(row.local));
    }
  }
  for (const row of rows) await keep(persist(row));
  // Drop receipts 30 days after a final status.
  for (const row of rows) {
    if (row.local?.ended_at && Date.now() - Date.parse(row.local.ended_at) > THIRTY_DAYS) await keep(receipts.remove(row.id));
  }
  setLinksCount(rows.filter((r) => !isFinal(r)).length);
  return rows.sort((a, b) => created(b).localeCompare(created(a)));
}

/** Signed in with the vault locked (the unlock prompt): Your links shows the account's links, but
 *  not what the vault keeps for them, so deleting one would leave its vault item to bring it back. Delete waits. */
export const deleteLocked = (): boolean => !!signedInUid() && !vaultItems.isOpen();

/** Delete from Your links (signed in: on every device). A link still waiting is destroyed first, so it stops working. */
export function deleteRow(r: Row): Promise<void> {
  return oneAtATime(() => remove(r));
}

async function remove(r: Row): Promise<void> {
  if (deleteLocked()) throw new Error('locked');
  if (isRequest(r)) {
    // Its link stops taking answers and an answer it has is destroyed, on the server first: the vault item holds the
    // only key to that answer. Already gone there (404): nothing more to do.
    if (r.local) await closeRequest(r.id, r.local.manage_token).catch((e) => {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    });
    await receipts.remove(r.id);
    return;
  }
  if (!isFinal(r) && r.local) await destroySecret(r.id, r.local.manage_token);
  await receipts.remove(r.id);
  if (signedInUid()) await api('DELETE', `/me/receipts/${encodeURIComponent(r.id)}`).catch(() => undefined);
}

/** Expired, as the list shows it: its time ran out (or, since then, the server has forgotten it). */
export const isExpired = (r: Row): boolean => {
  const s = r.remote?.status ?? r.local?.last_status;
  return s === 'expired' || s === 'gone';
};

/** Clear every expired link from Your links at once (they'd leave on their own after THIRTY_DAYS). One at a time, so
 *  the vault writes stay in order. */
export async function clearExpired(rows: Row[]): Promise<void> {
  for (const r of rows.filter(isExpired)) await deleteRow(r);
}

export const created = (r: Row) => r.local?.created_at ?? r.remote?.created_at ?? r.remote?.ended_at ?? '';

/** Keep the local copy current; delete the stored link (with its key) once the status is final. */
export async function persist(row: Row): Promise<void> {
  if (!row.local || !row.remote) return;
  const patch: Partial<StoredReceipt> = {};
  if (row.remote.status !== row.local.last_status) patch.last_status = row.remote.status;
  const opened = row.remote.events?.find((e) => e.type === 'secret.revealed')?.at;
  if (opened && !row.local.opened_at) patch.opened_at = opened;
  if (row.local.kind === 'request' && row.remote.status !== 'waiting' && row.local.link) patch.link = undefined; // spent
  if (isFinal(row)) {
    if (row.local.link) patch.link = undefined;
    if (row.local.key) patch.key = undefined; // nothing left to open with it
    if (!row.local.ended_at) patch.ended_at = row.remote.ended_at ?? new Date().toISOString();
  }
  if (Object.keys(patch).length) {
    row.local = { ...row.local, ...patch };
    await update(row.local);
  }
}

/** The header's count: links still waiting (and requests waiting for, or with, an answer), from what this browser and the account's vault keep (no status request). */
export async function waitingCount(): Promise<number> {
  const all = await receipts.all().catch(() => [] as StoredReceipt[]);
  return all.filter((r) => !r.ended_at && (r.last_status === 'waiting' || r.last_status === 'answered' || (r.last_status === 'opened' && r.views === null))).length;
}

/** How often Your links and a link's page read the statuses again, while the page is visible. */
export const POLL_MS = 30_000;

/** Calls `load` every POLL_MS while the page is visible, and when it's shown again (while `on`). */
export function usePoll(load: () => unknown, on = true): void {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    if (!on) return;
    const tick = () => document.visibilityState === 'visible' && void latest.current();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [on]);
}
