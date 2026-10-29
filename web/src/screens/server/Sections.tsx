/** Server tab sections E1–E5 and E7. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../../api/client';
import { bytes, dateTime, fold, num, relative, stamp, USERNAME } from '../../lib/format';
import { LANGUAGES, rich, t } from '../../lib/i18n';
import { loadConfig, shownUser, toast } from '../../lib/state';
import { Btn, copyText, ErrMsg, Radio, Status } from '../../ui/bits';
import { confirmDialog } from '../../ui/confirm';
import { BrandLockup } from '../../ui/chrome';
import { Dialog } from '../../ui/dialog';
import { Icon, Mark } from '../../ui/icons';
import { LogoDrop } from '../../ui/logo';
import { errorText } from '../errors';
import { Heading, LoadError, Lock, readOnly, SaveBar, sensitive, ServerShell, useServer } from './common';
import { actorText, eventText, EVENT_GROUPS, type AuditRow } from './labels';

// ------------------------------------------------------------------ E1 overview
interface Overview {
  version: string; update_available: string | null;
  storage: { used: number; disk_total: number; disk_free: number };
  live: { secrets: number; expiring_today: number }; week: { created: number; senders: number };
  cleanup: { last_run: string | null; removed: number };
  attention: Array<{ code: string; level: 'info' | 'warn' | 'error'; n?: number; pct?: number; minutes?: number; action?: string }>;
  recent: AuditRow[];
}

const ATTN: Record<string, (a: Overview['attention'][number]) => { title: string; body: string; action?: [string, string] }> = {
  disk: (a) => ({ title: t('server.attn_disk', { pct: a.pct }), body: t('server.attn_disk_body'), action: [t('server.limits'), '/server/limits'] }),
  cleanup: (a) => ({ title: t('server.attn_cleanup_title'), body: t('server.attn_cleanup', { minutes: a.minutes }) }),
};

export function OverviewSection() {
  const { data, error, reload } = useServer<Overview>('/server/overview');
  const host = location.host;
  return (
    <ServerShell active="overview">
      <Heading title={t('server.overview')} lede={data ? (data.update_available ? t('server.overview_lede_update', { host, version: data.version, update: data.update_available }) : t('server.overview_lede', { host, version: data.version })) : ' '} />
      {error && <LoadError error={error} retry={reload} />}
      {data && (
        <>
          <div class="health">
            <div class="metric"><small>{t('server.storage')}</small><b>{rich('server.storage_used', { size: bytes(data.storage.used), stored: <span>{t('server.stored')}</span> })}</b>
              <div class="meter" role="meter" aria-valuenow={data.storage.disk_total - data.storage.disk_free} aria-valuemin={0} aria-valuemax={data.storage.disk_total} aria-label={t('server.disk_used')}>
                <i style={{ width: `${Math.min(100, Math.max(2, (100 * (data.storage.disk_total - data.storage.disk_free)) / Math.max(1, data.storage.disk_total)))}%` }} /></div>
              <span class="sub">{t('server.disk_free', { free: bytes(data.storage.disk_free), total: bytes(data.storage.disk_total) })}</span></div>
            <div class="metric"><small>{t('server.live_links')}</small><b>{num(data.live.secrets)}</b><span class="sub">{t('server.expire_today', { n: data.live.expiring_today })}</span></div>
            <div class="metric"><small>{t('server.created_week')}</small><b>{num(data.week.created)}</b><span class="sub">{t('server.by_people', { n: data.week.senders })}</span></div>
            <div class="metric"><small>{t('server.cleanup')}</small>
              {data.cleanup.last_run ? <span class="okt"><Icon name="check" size="sm" />{t('server.cleanup_ran', { when: relative(data.cleanup.last_run) })}</span> : <span class="sub">{t('server.cleanup_never')}</span>}
              <span class="sub">{t('server.cleanup_removed', { n: data.cleanup.removed })}</span></div>
          </div>
          {data.attention.length > 0 && (
            <section class="card"><div class="card-h"><h2 class="h3">{t('server.needs_attention')}</h2></div><div class="attn-list">
              {data.attention.map((a) => {
                const x = ATTN[a.code]?.(a) ?? { title: a.code, body: '' };
                return (
                  <div class="attn-item" key={a.code}>
                    <Icon name={a.level === 'info' ? 'info' : 'alert'} class={a.level === 'info' ? 'i' : a.level === 'error' ? 'e' : 'w'} />
                    <span><b>{x.title}</b><small>{x.body}</small></span>
                    {x.action && <a class="btn sm ghost" href={x.action[1]}>{x.action[0]}</a>}
                  </div>
                );
              })}
            </div></section>
          )}
          <section class="card"><div class="card-h"><h2 class="h3">{t('server.recent_events')}</h2><a class="btn sm ghost" href="/server/audit">{t('server.audit')} <Icon name="arrow" size="sm" /></a></div>
            <div class="table-wrap"><table class="table resp ev"><tbody>
              {data.recent.length === 0 && <tr><td class="muted">{t('server.nothing_yet')}</td></tr>}
              {data.recent.map((e) => <tr key={e.id}><td class="mono">{stamp(e.at)}</td><td>{eventText(e)}</td><td class="muted">{actorText(e)}</td></tr>)}
            </tbody></table></div></section>
        </>
      )}
    </ServerShell>
  );
}

// ------------------------------------------------------------------ E2 access and people
interface Person {
  id: string; username: string; role: 'owner' | 'member'; status: 'active' | 'invited' | 'expired' | 'reset' | 'locked';
  invite_expires_at: string | null; reset_expires_at: string | null; last_seen_at: string | null;
}
interface Access { mode: 'anyone' | 'signed_in'; locked_by: string | null; people: Person[]; me: string }
interface InviteLink { name: string; invite_url: string; expires_at: string }
interface ResetLink { name: string; reset_url: string; code: string; expires_at: string }

export function AccessSection() {
  const { data, error, reload } = useServer<Access>('/server/access');
  const [adding, setAdding] = useState(false);
  const [invite, setInvite] = useState<InviteLink | null>(null);
  // The invite dialog opens after a request, from Add person (its dialog is gone by then) or a row's button: focus
  // goes back there when it closes.
  const inviteFrom = useRef<HTMLElement | null>(null);
  const [resetting, setResetting] = useState<Person | null>(null);
  const setMode = (mode: 'anyone' | 'signed_in') => sensitive(async () => {
    await api('PUT', '/server/access', { body: { mode } });
    toast(t('toast.saved'));
    await loadConfig();
    reload();
  });
  const name = (p: Person) => p.username;
  const setRole = (p: Person, role: 'owner' | 'member') => sensitive(async () => {
    await api('PATCH', `/server/users/${p.id}`, { body: { role } });
    toast(t('access.role_now', { name: name(p), role }));
    reload();
  });
  const reinvite = (p: Person) => {
    if (p.status !== 'invited' && p.status !== 'expired') return setResetting(p); // joined: a reset link and code
    inviteFrom.current = document.activeElement as HTMLElement | null;
    return sensitive(async () => {
      const r = await api<{ invite_url: string; expires_at: string }>('POST', `/server/users/${p.id}/invite`);
      setInvite({ name: name(p), ...r });
      reload();
    });
  };
  const remove = async (p: Person) => {
    if (!(await confirmDialog({
      title: t('access.remove_title', { name: name(p) }), confirm: t('people.remove'), danger: true,
      body: t('access.remove_body'),
    }))) return;
    await sensitive(async () => {
      await api('DELETE', `/server/users/${p.id}`);
      toast(t('access.removed', { name: name(p) }));
      reload();
    });
  };
  const [q, setQ] = useState('');
  const shown = data?.people.filter((p) => findPerson(p, q)) ?? [];
  return (
    <ServerShell active="access">
      <Heading title={t('server.access')} lede={t('access.lede')} />
      {error && <LoadError error={error} retry={reload} />}
      {data && (
        <>
          <section class="card"><div class="card-b">
            <div class="set"><div class="k"><b>{t('setup.access')}</b><small>{t('access.mode_help')}</small></div>
              <div class="stack">
                <div class="radios" role="radiogroup" aria-label={t('setup.access')}>
                  <Radio name="mode" on={data.mode === 'anyone'} onSelect={() => setMode('anyone')} title={t('access.anyone')} help={t('access.anyone_help')} disabled={data.locked_by || readOnly() ? ' ' : undefined} />
                  <Radio name="mode" on={data.mode === 'signed_in'} onSelect={() => setMode('signed_in')} title={t('access.signed_in')} help={t('access.signed_in_help')} disabled={data.locked_by || readOnly() ? ' ' : undefined} />
                </div>
                {data.locked_by && <Lock vars={data.locked_by} />}
              </div></div>
          </div></section>
          <section class="card">
            <div class="card-h"><div class="stack" style="gap:2px"><h2 class="h3">{t('people.title')}</h2><span class="muted small">{t('people.lede')}</span></div>
              {!readOnly() && <Btn kind="secondary" class="sm" icon="plus" onClick={(e) => { inviteFrom.current = e.currentTarget as HTMLElement; setAdding(true); }}>{t('people.add')}</Btn>}</div>
            <div class="people-search">
              <label class="input search">
                <Icon name="search" size="sm" />
                <input class="bare" type="search" value={q} placeholder={t('people.search')} aria-label={t('people.search')} autoComplete="off" spellcheck={false}
                  onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ(''); } }} />
                {q && <button type="button" class="btn icon sm ghost" aria-label={t('links.search_clear')} title={t('links.search_clear')} onClick={() => setQ('')}><Icon name="x" size="sm" /></button>}
              </label>
            </div>
            {shown.length ? <PeopleTable people={shown} me={data.me} onRole={setRole} onInvite={reinvite} onRemove={remove} />
              : <p class="people-empty muted">{t('people.search_empty', { q: q.trim() })}{' '}
                <button type="button" class="link" onClick={() => setQ('')}>{t('links.search_clear')}</button></p>}
          </section>
        </>
      )}
      {adding && <AddPersonDialog onClose={() => setAdding(false)} onAdded={(link) => { setAdding(false); setInvite(link); reload(); }} />}
      {invite && <InviteDialog invite={invite} returnTo={inviteFrom.current} onClose={() => setInvite(null)} />}
      {resetting && <ResetDialog person={resetting} onClose={() => { setResetting(null); reload(); }} />}
    </ServerShell>
  );
}

/** Every word typed must appear in the person's name, username or role. */
function findPerson(p: Person, q: string): boolean {
  const words = fold(q).split(/\s+/).filter(Boolean);
  const hay = fold([p.username, p.role === 'owner' ? t('people.owner') : t('people.member')].filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
}

function PeopleTable({ people, me, onRole, onInvite, onRemove }: {
  people: Person[]; me: string; onRole: (p: Person, r: 'owner' | 'member') => void; onInvite: (p: Person) => void; onRemove: (p: Person) => void;
}) {
  return (
    <div class="table-wrap"><table class="table resp ppl">
      <thead><tr><th>{t('people.person')}</th><th>{t('people.role')}</th><th>{t('people.status')}</th><th><span class="sr">{t('people.actions')}</span></th></tr></thead>
      <tbody>{people.map((p) => (
        <tr key={p.id}>
          <td><span class="ppl-name"><b>{p.username}</b>{p.id === me && <span class="chip">{t('people.you')}</span>}</span></td>
          <td>{p.role === 'owner' ? t('people.owner') : t('people.member')}</td>
          <td>{p.status === 'active' ? <span class="muted small">{p.last_seen_at ? t('people.seen', { when: relative(p.last_seen_at) }) : t('people.active')}</span>
            : p.status === 'invited' ? <Status kind="waiting">{t('people.invited_until', { date: dateTime(p.invite_expires_at!) })}</Status>
              : p.status === 'reset' ? <Status kind="warn">{t('people.reset_until', { date: dateTime(p.reset_expires_at!) })}</Status>
                : p.status === 'locked' ? <Status kind="danger">{t('people.locked')}</Status>
                  : <Status kind="expired">{t('people.invite_expired')}</Status>}</td>
          <td style="text-align:right;white-space:nowrap">{!readOnly() && p.id !== me && <>
            <button class="btn sm ghost" onClick={() => onRole(p, p.role === 'owner' ? 'member' : 'owner')}>{p.role === 'owner' ? t('people.make_member') : t('people.make_owner')}</button>
            <button class="btn sm ghost" onClick={() => onInvite(p)}>{p.status === 'invited' || p.status === 'expired' ? t('people.new_invite') : t('people.reset_signin')}</button>
            <button class="btn sm ghost danger" onClick={() => onRemove(p)}>{t('people.remove')}</button>
          </>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function AddPersonDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (l: InviteLink) => void }) {
  const [f, setF] = useState({ username: '', role: 'member' as 'member' | 'owner' });
  const [err, setErr] = useState<{ field?: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setErr(null);
    if (!USERNAME.test(f.username.trim())) return setErr({ field: 'username', text: t('people.username_invalid') });
    setBusy(true);
    await sensitive(async () => {
      try {
        const r = await api<{ invite_url: string; expires_at: string }>('POST', '/server/users', { body: { username: f.username.trim(), role: f.role } });
        onAdded({ name: f.username.trim().toLowerCase(), ...r });
      } catch (e) {
        if ((e as { code?: string }).code === 'reauth_required') throw e;
        setErr({ field: (e as { field?: string }).field, text: errorText(e) });
      }
    });
    setBusy(false);
  };
  const fe = (k: string) => (err?.field === k ? err.text : null);
  return (
    <Dialog open onClose={onClose} labelledBy="add-title" footer={<><button class="btn secondary" onClick={onClose}>{t('send.cancel')}</button><Btn type="submit" form="ap-form" kind="primary" loading={busy}>{t('people.add_submit')}</Btn></>}>
      <h2 class="h3" id="add-title">{t('people.add_title')}</h2>
      <form class="stack" id="ap-form" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
        <div><label class="label" for="ap-username">{t('signin.username')}</label><input id="ap-username" class={`input${fe('username') ? ' err' : ''}`} value={f.username} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellcheck={false} maxLength={32} data-autofocus
          aria-invalid={!!fe('username')} aria-describedby={fe('username') ? 'ap-username-err' : 'ap-username-help'} onInput={(e) => setF({ ...f, username: (e.target as HTMLInputElement).value })} />
          {fe('username') ? <ErrMsg id="ap-username-err">{fe('username')}</ErrMsg> : <p class="help" id="ap-username-help">{t('signin.username_help')}</p>}</div>
        <div class="radios" role="radiogroup" aria-label={t('people.role')}>
          <Radio name="role" on={f.role === 'member'} onSelect={() => setF({ ...f, role: 'member' })} title={t('people.member')} help={t('people.member_help')} />
          <Radio name="role" on={f.role === 'owner'} onSelect={() => setF({ ...f, role: 'owner' })} title={t('people.owner')} help={t('people.owner_help')} />
        </div>
        {err && !err.field && <ErrMsg>{err.text}</ErrMsg>}
      </form>
    </Dialog>
  );
}

function InviteDialog({ invite, returnTo, onClose }: { invite: InviteLink; returnTo: HTMLElement | null; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} labelledBy="inv-title" returnTo={returnTo} footer={<Btn kind="primary" onClick={onClose}>{t('send.done')}</Btn>}>
      <h2 class="h3" id="inv-title">{t('people.invite_title', { name: invite.name })}</h2>
      <p class="muted small">{t('people.invite_body', { date: dateTime(invite.expires_at) })}</p>
      <div class="linkbox"><span class="url mono">{location.origin + invite.invite_url}</span>
        <Btn kind="primary" class="sm" icon="copy" onClick={() => void copyText(location.origin + invite.invite_url)}>{t('reveal.copy')}</Btn></div>
      <p class="fine">{t('people.invite_tip')}</p>
    </Dialog>
  );
}

/** Reset someone's password: a link and a separate code, meant to travel by different channels. */
function ResetDialog({ person, onClose }: { person: Person; onClose: () => void }) {
  const who = person.username;
  const [lock, setLock] = useState(false);
  const [link, setLink] = useState<ResetLink | null>(null);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    await sensitive(async () => {
      const r = await api<{ reset_url: string; code: string; expires_at: string }>('POST', `/server/users/${person.id}/reset`, { body: { lock } });
      setLink({ name: who, ...r });
    });
    setBusy(false);
  };
  if (link) {
    return (
      <Dialog open onClose={onClose} labelledBy="rl-title" footer={<Btn kind="primary" onClick={onClose}>{t('send.done')}</Btn>}>
        <h2 class="h3" id="rl-title">{t('people.reset_ready_title', { name: who })}</h2>
        <p class="muted small">{t('people.reset_ready_body', { date: dateTime(link.expires_at) })}</p>
        <span class="label">{t('people.link')}</span>
        <div class="linkbox"><span class="url mono">{location.origin + link.reset_url}</span>
          <Btn kind="primary" class="sm" icon="copy" onClick={() => void copyText(location.origin + link.reset_url)}>{t('reveal.copy')}</Btn></div>
        <span class="label">{t('people.code')}</span>
        <div class="linkbox"><span class="url mono reset-code">{link.code}</span>
          <Btn kind="secondary" class="sm" icon="copy" onClick={() => void copyText(link.code)}>{t('reveal.copy')}</Btn></div>
      </Dialog>
    );
  }
  return (
    <Dialog open onClose={onClose} labelledBy="rl-title" footer={<><button class="btn secondary" onClick={onClose}>{t('send.cancel')}</button>
      <Btn kind="primary" loading={busy} onClick={make}>{t('access.reset_confirm')}</Btn></>}>
      <h2 class="h3" id="rl-title">{t('access.reset_title', { name: who })}</h2>
      <p class="muted small">{t('access.reset_body')}</p>
      <label class="check"><input type="checkbox" checked={lock} onChange={(e) => setLock((e.target as HTMLInputElement).checked)} />
        <span><b>{t('access.lock')}</b><small>{t('access.lock_help')}</small></span></label>
    </Dialog>
  );
}

// ------------------------------------------------------------------ E3 limits
interface Limit { value: number; locked_by: string | null; min: number; max: number | null }
interface Limits { items: Record<string, Limit>; disk_free: number }

/** One row per limit. Its title is limits.<key>, its help limits.<key>_help, its unit limits.unit_<unit> and a count limits.n_<unit>. */
type LimitUi = { key: string; help?: boolean; unit: 'hours' | 'days' | 'mb' | 'files' | 'characters'; toUi: (v: number) => number; fromUi: (v: number) => number };
/** Longest expiry reads in hours or days, whichever the owner picks; it starts on hours when the value isn't whole days. */
const expiryUi = (unit: 'hours' | 'days'): LimitUi => {
  const s = unit === 'days' ? 86400 : 3600;
  return { key: 'max_expiration', help: true, unit, toUi: (v) => +(v / s).toFixed(2), fromUi: (v) => Math.round(v * s) };
};
/** The unit as it reads after the number typed: "1 hour", "2 hours" (from the plural forms, so every language agrees). */
const unitFor = (unit: LimitUi['unit'], raw: string): string => {
  const n = Number(raw);
  if (!raw.trim() || !Number.isFinite(n)) return t(`limits.unit_${unit}`);
  return t(`limits.n_${unit}`, { n }).replace(num(n), '').trim() || t(`limits.unit_${unit}`);
};
const LIMIT_BASE: LimitUi[] = [
  expiryUi('days'),
  { key: 'max_file_size', help: true, unit: 'mb', toUi: (v) => Math.round(v / 1024 ** 2), fromUi: (v) => Math.round(v * 1024 ** 2) },
  { key: 'max_files', unit: 'files', toUi: (v) => v, fromUi: (v) => v },
  { key: 'max_message_length', unit: 'characters', toUi: (v) => v, fromUi: (v) => v },
  { key: 'audit_retention_days', unit: 'days', toUi: (v) => v, fromUi: (v) => v },
];

export function LimitsSection() {
  const { data, error, reload } = useServer<Limits>('/server/limits');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [expUnit, setExpUnit] = useState<'hours' | 'days' | null>(null);
  const unit = expUnit ?? (data && data.items.max_expiration.value % 86400 !== 0 ? 'hours' : 'days');
  const LIMIT_UI = LIMIT_BASE.map((l) => (l.key === 'max_expiration' ? expiryUi(unit) : l));
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<Record<string, string>>({});
  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    if (!data) return out;
    for (const l of LIMIT_UI) {
      if (!(l.key in edits)) continue;
      const v = Number(edits[l.key]);
      const item = data.items[l.key];
      const count = (n: number) => t(`limits.n_${l.unit}`, { n: l.toUi(n) });
      if (!edits[l.key].trim() || !Number.isFinite(v)) out[l.key] = t('limits.enter_number');
      else if (item.max !== null && l.fromUi(v) > item.max) out[l.key] = t('limits.too_high', { value: count(item.max) });
      else if (l.fromUi(v) < item.min) out[l.key] = t('limits.too_low', { value: count(item.min) });
    }
    return { ...out, ...serverErr };
  }, [edits, data, serverErr, unit]);
  const changed = Object.keys(edits).filter((k) => data && Number(edits[k]) !== LIMIT_UI.find((l) => l.key === k)!.toUi(data.items[k].value));
  const nErr = Object.keys(errors).length;
  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, number> = {};
      for (const k of changed) body[k] = LIMIT_UI.find((l) => l.key === k)!.fromUi(Number(edits[k]));
      await api('PUT', '/server/limits', { body });
      setEdits({});
      setServerErr({});
      toast(t('server.saved'));
      reload();
      void loadConfig();
    } catch (e) {
      const f = (e as { field?: string }).field;
      if (f) setServerErr({ [f]: errorText(e) });
      else toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <ServerShell active="limits">
      <Heading title={t('server.limits')} lede={t('limits.lede')} />
      {error && <LoadError error={error} retry={reload} />}
      {data && (
        <section class="card"><div class="card-b">
          {LIMIT_UI.map((l) => {
            const item = data.items[l.key];
            const value = edits[l.key] ?? String(l.toUi(item.value));
            const err = errors[l.key];
            return (
              <div class="set" key={l.key}>
                <div class="k"><b><label for={`lim-${l.key}`}>{t(`limits.${l.key}`)}</label></b>{l.help && <small id={`lim-${l.key}-help`}>{t(`limits.${l.key}_help`, { free: bytes(data.disk_free) })}</small>}</div>
                <div class="stack" style="gap:8px">
                  <div class={`input${err ? ' err' : ''}${item.locked_by ? ' locked' : ''}`} style="max-width:260px">
                    <input id={`lim-${l.key}`} class="bare" inputMode="decimal" value={value} disabled={!!item.locked_by || readOnly()} aria-invalid={!!err}
                      aria-describedby={err ? `lim-${l.key}-err` : l.help ? `lim-${l.key}-help` : undefined}
                      onInput={(e) => { setServerErr({}); setEdits({ ...edits, [l.key]: (e.target as HTMLInputElement).value }); }} />
                    {l.key === 'max_expiration' ? (
                      <select class="unit unit-pick" value={unit} aria-label={t('limits.unit_label')} disabled={!!item.locked_by || readOnly()}
                        onChange={(e) => {
                          const next = (e.target as HTMLSelectElement).value as 'hours' | 'days';
                          if (l.key in edits && Number.isFinite(Number(edits[l.key]))) setEdits({ ...edits, [l.key]: String(expiryUi(next).toUi(l.fromUi(Number(edits[l.key])))) });
                          setExpUnit(next);
                        }}>
                        <option value="hours">{unitFor('hours', value)}</option><option value="days">{unitFor('days', value)}</option>
                      </select>
                    ) : <span class="unit">{unitFor(l.unit, value)}</span>}
                    {item.locked_by && <span class="lock-ic" role="img" title={t('server.locked_by_env', { vars: item.locked_by })} aria-label={t('server.locked_by_env', { vars: item.locked_by })}><Icon name="lock" size="sm" /></span>}
                  </div>
                  {err && <ErrMsg id={`lim-${l.key}-err`}>{err}</ErrMsg>}
                </div>
              </div>
            );
          })}
        </div></section>
      )}
      {changed.length > 0 && (
        <SaveBar summary={nErr ? t('limits.errors', { n: nErr }) : t('server.unsaved', { n: changed.length })} invalid={nErr > 0} busy={busy}
          onDiscard={() => { setEdits({}); setServerErr({}); }} onSave={save} back={() => document.getElementById(`lim-${changed[0]}`)} />
      )}
    </ServerShell>
  );
}

// ------------------------------------------------------------------ E4 branding
interface Branding { name: string; logo_url: string | null; name_locked_by: string | null; logo_name: string | null }

export function BrandingSection() {
  const { data, error, reload } = useServer<Branding>('/server/branding');
  const [name, setName] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api('PUT', '/server/branding', { body: { name } });
      setName(null);
      toast(t('server.saved'));
      reload();
      void loadConfig();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const shownName = name ?? data?.name ?? '';
  const sender = shownUser()!.username; // the owner here, or the demo's sample owner
  const host = location.host;
  return (
    <ServerShell active="branding">
      <Heading title={t('server.branding')} lede={t('branding.lede')} />
      {error && <LoadError error={error} retry={reload} />}
      {data && (
        <section class="card"><div class="card-b">
          <div class="set"><div class="k"><b><label for="b-name">{t('branding.name')}</label></b></div>
            <div><input id="b-name" class={`input${err ? ' err' : ''}`} value={shownName} placeholder="Cryptex" maxLength={40} disabled={!!data.name_locked_by || readOnly()}
              aria-invalid={!!err} aria-describedby={err ? 'b-name-err' : data.name_locked_by ? undefined : 'b-name-help'} onInput={(e) => { setErr(null); setName((e.target as HTMLInputElement).value); }} />
              {data.name_locked_by ? <div style="margin-top:8px"><Lock vars={data.name_locked_by} /></div> : <p class="help" id="b-name-help">{t('branding.name_help', { suffix: t('app.brand_suffix') })}</p>}
              {err && <ErrMsg id="b-name-err">{err}</ErrMsg>}</div></div>
          <div class="set"><div class="k"><b>{t('branding.logo')}</b><small>{t('branding.logo_help')}</small></div>
            <LogoDrop logoUrl={data.logo_url} logoName={data.logo_name} disabled={readOnly()} onChange={() => { reload(); void loadConfig(); }} /></div>
          <div class="set"><div class="k"><b>{t('branding.preview')}</b></div>
            <div class="stack" style="gap:8px"><div class="preview">
              <div class="pv-bar" aria-hidden="true"><span class="pv-dots"><i /><i /><i /></span>
                <span class="pv-url"><Icon name="lock" size="sm" /><span class="pv-host">{host}</span><span class="pv-path">/s/k7Qp2vR9mL</span></span></div>
              <header class="hd"><span class="brand"><BrandLockup name={shownName.trim()} logoUrl={data.logo_url} sub /></span></header>
              <div style="padding:18px"><div class="sealed"><div class="sealed-top tint" style="height:76px"><span class="seal-badge"><Mark />{t('reveal.sealed')}</span></div>
                <div class="sealed-body" style="padding:16px 18px;gap:8px"><p class="from">{shownName
                  ? rich('reveal.from', { sender: <b>{sender}</b>, brand: shownName })
                  : rich('branding.preview_from', { sender: <b>{sender}</b> })}</p><p class="h3">{t('branding.preview_title')}</p></div></div></div>
            </div><p class="help">{t('branding.preview_caption')}</p></div></div>
        </div></section>
      )}
      {name !== null && (
        <SaveBar summary={t('server.unsaved', { n: 1 })} busy={busy} onDiscard={() => { setName(null); setErr(null); }} onSave={save}
          back={() => document.getElementById('b-name')} />
      )}
    </ServerShell>
  );
}

// ------------------------------------------------------------------ language
/** Like Limits and Branding, a choice here only takes effect with Save: it changes the language for every visitor. */
export function LanguageSection() {
  const { data, error: loadErr, reload } = useServer<{ language: string; locked_by: string | null }>('/server/language');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null); // 'auto' or a language code, not saved yet
  const lastFixed = data && data.language !== 'auto' ? data.language : 'en'; // what "Always" starts on
  const value = draft ?? data?.language ?? 'auto';
  const changed = !!data && draft !== null && draft !== data.language;
  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api('PUT', '/server/language', { body: { language: value } });
      setDraft(null);
      toast(t('server.saved'));
      reload();
      await loadConfig();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const off = data?.locked_by || readOnly() ? ' ' : undefined;
  const always = value !== 'auto';
  const chosen = always ? value : lastFixed;
  const name = (code: string | undefined) => LANGUAGES.find((l) => l.code === code)?.name ?? '';
  return (
    <ServerShell active="language">
      <Heading title={t('server.language')} lede={t('server.language_lede')} />
      {loadErr && <LoadError error={loadErr} retry={reload} />}
      {data && (
        <section class="card"><div class="card-b">
          <div class="set"><div class="k"><b>{t('server.language_label')}</b><small>{t('server.language_device')}</small></div>
            <div class="stack">
              <div class="radios" role="radiogroup" aria-label={t('server.language_label')}>
                <Radio name="language" on={!always} onSelect={() => { setErr(null); setDraft('auto'); }} title={t('server.language_auto')} help={t('server.language_auto_help')} disabled={off} />
                <Radio name="language" on={always} onSelect={() => { setErr(null); setDraft(chosen); }} title={t('server.language_fixed')}
                  help={always ? t('server.language_fixed_help', { language: name(chosen) }) : undefined} disabled={off}>
                  <select class="input select" value={chosen} aria-label={t('server.language_fixed')} disabled={!!off}
                    onChange={(e) => { setErr(null); setDraft((e.target as HTMLSelectElement).value); }}>
                    {LANGUAGES.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}
                  </select>
                </Radio>
              </div>
              {data.locked_by && <Lock vars={data.locked_by} />}
              {err && <ErrMsg>{err}</ErrMsg>}
            </div></div>
        </div></section>
      )}
      {changed && (
        <SaveBar summary={t('server.unsaved', { n: 1 })} busy={busy} onDiscard={() => { setDraft(null); setErr(null); }} onSave={save}
          back={() => document.querySelector<HTMLElement>('[name=language]:checked')} />
      )}
    </ServerShell>
  );
}

// ------------------------------------------------------------------ E7 audit
export function AuditSection() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const from = useMemo(() => (days ? new Date(Date.now() - days * 86400_000).toISOString().replace(/\.\d+Z$/, 'Z') : ''), [days]);
  const qs = (cursor?: string) => new URLSearchParams({ ...(q.trim() ? { q: q.trim() } : {}), ...(type ? { type } : {}), ...(from ? { from } : {}), ...(cursor ? { cursor } : {}) }).toString();
  const { data, loading, error, reload } = useServer<{ items: AuditRow[]; next: string | null }>(`/server/audit?${qs()}`);
  const limits = useServer<Limits>('/server/limits'); // how long the log is kept (Limits › Keep the audit log)
  const [moreBusy, setMoreBusy] = useState(false);
  useEffect(() => {
    if (data) {
      setRows(data.items);
      setNext(data.next);
    }
  }, [data]);
  const more = async () => {
    setMoreBusy(true);
    try {
      const r = await api<{ items: AuditRow[]; next: string | null }>('GET', `/server/audit?${qs(next!)}`);
      setRows([...rows, ...r.items]);
      setNext(r.next);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setMoreBusy(false);
    }
  };
  const retention = limits.data?.items.audit_retention_days?.value;
  return (
    <ServerShell active="audit">
      <Heading title={t('server.audit')} lede={retention ? t('audit.lede', { days: retention }) : t('audit.lede_plain')}
        action={!readOnly() && <a class="btn secondary" href={`/api/v1/server/audit.csv?${qs()}`} download rel="external"><Icon name="down" size="sm" />{t('server.export_csv')}</a>} />
      <div class="row filters">
        <label class="input search" style="width:280px"><Icon name="search" size="sm" /><input class="bare" placeholder={t('audit.search')} value={q} aria-label={t('audit.search')}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></label>
        <select class="chip select" value={type} aria-label={t('audit.event_type')} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
          {EVENT_GROUPS.map((g) => <option key={g.value} value={g.value}>{t(g.label)}</option>)}
        </select>
        <select class="chip select" value={days} aria-label={t('audit.time_range')} onChange={(e) => setDays(Number((e.target as HTMLSelectElement).value))}>
          <option value={1}>{t('audit.last_24h')}</option><option value={7}>{t('audit.last_7d')}</option><option value={30}>{t('audit.last_30d')}</option><option value={0}>{t('audit.all_time')}</option>
        </select>
      </div>
      {error && <LoadError error={error} retry={reload} />}
      <section class="card"><div class="table-wrap"><table class="table resp ev">
        <thead><tr><th>{t('audit.time')}</th><th>{t('audit.event')}</th><th>{t('audit.by')}</th><th>{t('audit.link')}</th></tr></thead>
        <tbody aria-busy={loading || undefined}>
          {rows.length === 0 && !loading && !error && <tr><td colSpan={4} class="muted">{t('audit.no_match')}</td></tr>}
          {rows.length === 0 && loading && <tr><td colSpan={4}><div class="skeleton line" /></td></tr>}
          {rows.map((e) => <tr key={e.id}><td class="mono">{stamp(e.at)}</td><td>{eventText(e)}</td><td class={e.actor === 'link' || e.actor === 'system' ? 'muted' : ''}>{actorText(e)}</td><td class={e.item ? 'mono' : 'mono none'}>{e.item ?? '—'}</td></tr>)}
        </tbody>
      </table></div></section>
      {next && <Btn kind="secondary" class="load-more" loading={moreBusy} onClick={more}>{t('audit.load_more')}</Btn>}
    </ServerShell>
  );
}

