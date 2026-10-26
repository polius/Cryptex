/** Server tab sections E1–E5 and E7. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../../api/client';
import { bytes, relative, stamp } from '../../lib/format';
import { t } from '../../lib/i18n';
import { config, loadConfig, toast } from '../../lib/state';
import { Banner, Btn, copyText, ErrMsg, Radio, Status } from '../../ui/bits';
import { Dialog } from '../../ui/dialog';
import { Icon, Mark } from '../../ui/icons';
import { errorText } from '../errors';
import { Heading, Lock, readOnly, sensitive, ServerShell, useServer } from './common';
import { actorText, eventText, EVENT_GROUPS, type AuditRow } from './labels';

// ------------------------------------------------------------------ E1 overview
interface Overview {
  version: string; update_available: string | null; public_url: string;
  storage: { used: number; disk_total: number; disk_free: number };
  live: { secrets: number; requests: number; expiring_today: number }; week: { created: number; senders: number };
  cleanup: { last_run: string | null; removed: number };
  attention: Array<{ code: string; level: 'info' | 'warn' | 'error'; n?: number; emails?: string[]; pct?: number; minutes?: number; action?: string }>;
  recent: AuditRow[];
}

const ATTN: Record<string, (a: Overview['attention'][number]) => { title: string; body: string; action?: [string, string] }> = {
  smtp: () => ({ title: t('server.attn_smtp'), body: t('server.attn_smtp_body'), action: ['Set up email', '/server/notifications'] }),
  '2fa': (a) => ({ title: `2FA is off for ${a.n} ${a.n === 1 ? 'owner' : 'owners'}`, body: `${a.emails?.join(', ')} ${a.n === 1 ? 'signs' : 'sign'} in with a password only.`, action: ['Review', '/server/access'] }),
  disk: (a) => ({ title: t('server.attn_disk', { pct: a.pct }), body: 'New uploads fail when the disk is full. Lower the file size limit or add space.', action: ['Limits', '/server/limits'] }),
  cleanup: (a) => ({ title: 'Cleanup isn’t running', body: t('server.attn_cleanup', { minutes: a.minutes }) }),
  https: () => ({ title: 'This server isn’t using HTTPS', body: 'Link keys are only private over HTTPS. Put Cryptex behind a TLS proxy and set PUBLIC_URL.' }),
};

export function OverviewSection() {
  const { data, error } = useServer<Overview>('/server/overview');
  const host = data ? new URL(data.public_url).host : '';
  return (
    <ServerShell active="overview" attention={data?.attention.map((a) => (a.code === 'smtp' ? 'notifications' : a.code === '2fa' ? 'access' : '')) ?? []}>
      <Heading title={t('server.overview')} lede={data ? `${host} · version ${data.version}${data.update_available ? ` · ${data.update_available} available` : ' · up to date'}` : ' '} />
      {error && <Banner kind="danger" icon="alert">{error}</Banner>}
      {data && (
        <>
          <div class="health">
            <div class="metric"><small>{t('server.storage')}</small><b>{bytes(data.storage.used)} <span>stored</span></b>
              <div class="meter" role="meter" aria-valuenow={data.storage.disk_total - data.storage.disk_free} aria-valuemin={0} aria-valuemax={data.storage.disk_total} aria-label="Disk used">
                <i style={{ width: `${Math.min(100, Math.max(2, (100 * (data.storage.disk_total - data.storage.disk_free)) / Math.max(1, data.storage.disk_total)))}%` }} /></div>
              <span class="sub">{bytes(data.storage.disk_free)} free of {bytes(data.storage.disk_total)}</span></div>
            <div class="metric"><small>{t('server.live_links')}</small><b>{data.live.secrets + data.live.requests}</b><span class="sub">{t('server.expire_today', { n: data.live.expiring_today })}</span></div>
            <div class="metric"><small>{t('server.created_week')}</small><b>{data.week.created}</b><span class="sub">{t('server.by_people', { n: data.week.senders })}</span></div>
            <div class="metric"><small>{t('server.cleanup')}</small>
              {data.cleanup.last_run ? <span class="okt"><Icon name="check" size="sm" />{t('server.cleanup_ran', { when: relative(data.cleanup.last_run) })}</span> : <span class="sub">Not run yet</span>}
              <span class="sub">Removed {data.cleanup.removed} expired {data.cleanup.removed === 1 ? 'item' : 'items'}</span></div>
          </div>
          {data.attention.length > 0 && (
            <section class="card"><div class="card-h"><h2 class="h3">{t('server.needs_attention')}</h2></div><div class="attn-list">
              {data.attention.map((a) => {
                const x = ATTN[a.code]?.(a) ?? { title: a.code, body: '' };
                return (
                  <div class="attn-item" key={a.code}>
                    <Icon name={a.level === 'info' ? 'info' : 'alert'} class={a.level === 'info' ? 'i' : a.level === 'error' ? 'e' : 'w'} />
                    <span><b>{x.title}</b><small>{x.body}</small></span>
                    {x.action && <a class={`btn sm ${a.code === 'smtp' ? 'secondary' : 'ghost'}`} href={x.action[1]}>{x.action[0]}</a>}
                  </div>
                );
              })}
            </div></section>
          )}
          <section class="card"><div class="card-h"><h2 class="h3">Recent events</h2><a class="btn sm ghost" href="/server/audit">{t('server.audit')} <Icon name="arrow" size="sm" /></a></div>
            <div class="table-wrap"><table class="table"><tbody>
              {data.recent.length === 0 && <tr><td class="muted">Nothing yet.</td></tr>}
              {data.recent.map((e) => <tr key={e.id}><td class="mono">{stamp(e.at)}</td><td>{eventText(e)}</td><td class="muted">{actorText(e)}</td></tr>)}
            </tbody></table></div></section>
        </>
      )}
    </ServerShell>
  );
}

// ------------------------------------------------------------------ E2 access and people
interface Person { id: string; email: string; name: string; role: 'owner' | 'member'; mfa: boolean; sign_in: 'sso' | 'password'; last_seen_at: string | null }
interface Access { mode: 'anyone' | 'signed_in'; locked_by: string | null; sso: { enabled: boolean; name: string; issuer: string | null; domains: string[] }; people: Person[]; me: string }

export function AccessSection() {
  const { data, reload } = useServer<Access>('/server/access');
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const setMode = (mode: 'anyone' | 'signed_in') => sensitive(async () => {
    await api('PUT', '/server/access', { body: { mode } });
    toast(t('toast.saved'));
    await loadConfig();
    reload();
  });
  const setRole = (p: Person, role: 'owner' | 'member') => sensitive(async () => {
    await api('PATCH', `/server/users/${p.id}`, { body: { role } });
    toast(`${p.name || p.email} is now ${role === 'owner' ? 'an owner' : 'a member'}`);
    reload();
  });
  const owners = data?.people.filter((p) => p.role === 'owner') ?? [];
  const members = data?.people.filter((p) => p.role === 'member') ?? [];
  const me = data?.people.find((p) => p.id === data.me);
  return (
    <ServerShell active="access">
      <Heading title={t('server.access')} lede="Who can create links, and how people sign in. Opening a link never needs an account." />
      {data && (
        <section class="card"><div class="card-b">
          <div class="set"><div class="k"><b>Who can create links</b><small>Applies to Send and Request.</small></div>
            <div class="stack">
              <div class="radios" role="radiogroup" aria-label="Who can create links">
                <Radio name="mode" on={data.mode === 'anyone'} onSelect={() => setMode('anyone')} title="Anyone who visits" help="Good on a private network. Rate limits still apply." disabled={data.locked_by || readOnly() ? ' ' : undefined} />
                <Radio name="mode" on={data.mode === 'signed_in'} onSelect={() => setMode('signed_in')} title="People who sign in" help="Recommended on the internet. People without an account can still answer requests." disabled={data.locked_by || readOnly() ? ' ' : undefined} />
              </div>
              {data.locked_by && <Lock vars={data.locked_by} />}
            </div></div>
          <div class="set"><div class="k"><b>Single sign-on</b><small>OpenID Connect: Google Workspace, Entra ID, Okta, Keycloak…</small></div>
            <div class="stack">
              {data.sso.enabled ? (
                <span class="row"><Status kind="opened">Connected</Status><span class="muted small">{data.sso.name}{data.sso.domains.length ? ` · ${data.sso.domains.join(', ')} only` : ''}</span></span>
              ) : <span class="row"><Status kind="expired">Not set up</Status><span class="muted small">People can’t sign in, and org-only links are off.</span></span>}
              <Lock vars={data.sso.enabled ? 'OIDC_ISSUER, OIDC_ALLOWED_DOMAINS' : 'OIDC_ISSUER, OIDC_CLIENT_ID'} />
            </div></div>
          <div class="set"><div class="k"><b>Owners</b><small>Can open the Server tab. The last owner can’t be removed.</small></div>
            <PeopleTable people={owners} me={data.me} onRole={setRole} />
          </div>
          {members.length > 0 && (
            <div class="set"><div class="k"><b>Members</b><small>People who signed in with single sign-on.</small></div>
              <PeopleTable people={members} me={data.me} onRole={setRole} /></div>
          )}
          {me && me.sign_in === 'password' && !readOnly() && (
            <div class="set"><div class="k"><b>Your sign-in</b><small>Password and a code from an authenticator app, asked at every sign-in.</small></div>
              <div class="stack">
                <Btn kind="secondary" icon="key" onClick={() => setPwOpen(true)}>Change password</Btn>
                {me.mfa ? <span class="row"><Status kind="opened">On</Status><button class="btn sm ghost danger" onClick={() => sensitive(async () => { await api('DELETE', '/me/totp'); toast('2FA turned off'); reload(); })}>Turn off</button></span>
                  : <Btn kind="secondary" icon="shield" onClick={async () => setTotp(await api('POST', '/me/totp'))}>Turn on 2FA</Btn>}
              </div></div>
          )}
        </div></section>
      )}
      {pwOpen && <PasswordDialog onClose={() => setPwOpen(false)} />}
      {totp && <TotpDialog setup={totp} onClose={() => setTotp(null)} onDone={() => { setTotp(null); reload(); void loadConfig(); }} />}
    </ServerShell>
  );
}

function PeopleTable({ people, me, onRole }: { people: Person[]; me: string; onRole: (p: Person, r: 'owner' | 'member') => void }) {
  return (
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Person</th><th>Sign-in</th><th>2FA</th><th><span class="sr">Actions</span></th></tr></thead>
      <tbody>{people.map((p) => (
        <tr key={p.id}>
          <td><b>{p.name || p.email}</b>{p.id === me && <span class="chip" style="margin-left:6px">You</span>}<br /><span class="muted small">{p.email}</span></td>
          <td>{p.sign_in === 'sso' ? (config.value?.features.sso_name || 'SSO') : 'Password'}</td>
          <td>{p.sign_in === 'sso' ? <span class="muted small">By provider</span> : p.mfa ? <Status kind="opened">On</Status> : <Status kind="warn">Off</Status>}</td>
          <td style="text-align:right">{!readOnly() && (p.role === 'owner'
            ? <button class="btn sm ghost" onClick={() => onRole(p, 'member')}>Make member</button>
            : <button class="btn sm ghost" onClick={() => onRole(p, 'owner')}>Make owner</button>)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setErr(null);
    if (next.length < 12) return setErr('Use at least 12 characters.');
    setBusy(true);
    try {
      await api('PUT', '/me/password', { body: { current: cur, new: next } });
      toast('Password changed. Other devices were signed out.');
      onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} labelledBy="pw-title" footer={<><button class="btn secondary" onClick={onClose}>{t('send.cancel')}</button><Btn kind="primary" loading={busy} onClick={save}>Change password</Btn></>}>
      <h2 class="h3" id="pw-title">Change your password</h2>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div><label class="label" for="pw-cur">Current password</label><input id="pw-cur" class="input" type="password" autoComplete="current-password" value={cur} data-autofocus onInput={(e) => setCur((e.target as HTMLInputElement).value)} /></div>
        <div><label class="label" for="pw-new">New password</label><input id="pw-new" class="input" type="password" autoComplete="new-password" minLength={12} value={next} onInput={(e) => setNext((e.target as HTMLInputElement).value)} />
          <p class="help">At least 12 characters. Other devices are signed out.</p></div>
        {err && <ErrMsg>{err}</ErrMsg>}
        <button type="submit" class="sr">Change password</button>
      </form>
    </Dialog>
  );
}

function TotpDialog({ setup, onClose, onDone }: { setup: { secret: string; uri: string }; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [QR, setQR] = useState<null | ((p: { text: string; label: string }) => preact.JSX.Element)>(null);
  useEffect(() => { void import('../../ui/qr').then((m) => setQR(() => m.QR)); }, []);
  const confirm = () => sensitive(async () => {
    try {
      await api('PUT', '/me/totp', { body: { secret: setup.secret, code } });
      toast('2FA is on');
      onDone();
    } catch (e) {
      if ((e as { code?: string }).code === 'reauth_required') throw e;
      setErr(errorText(e));
    }
  });
  return (
    <Dialog open onClose={onClose} labelledBy="totp-title" footer={<><button class="btn secondary" onClick={onClose}>{t('send.cancel')}</button><Btn kind="primary" onClick={confirm}>Turn on</Btn></>}>
      <h2 class="h3" id="totp-title">Scan with your authenticator app</h2>
      <div class="qrbox">{QR && <QR text={setup.uri} label="Authenticator setup code" />}</div>
      <p class="fine">Or enter this key: <span class="mono">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span></p>
      <div><label class="label" for="totp-code">Code from the app</label>
        <input id="totp-code" class="input code" inputMode="numeric" maxLength={6} value={code} data-autofocus onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} /></div>
      {err && <ErrMsg>{err}</ErrMsg>}
    </Dialog>
  );
}

// ------------------------------------------------------------------ E3 limits
interface Limit { value: number; locked_by: string | null; min: number; max: number }
interface Limits { items: Record<string, Limit>; disk_free: number }

const LIMIT_UI: Array<{ key: string; title: string; help?: string; unit: string; toUi: (v: number) => number; fromUi: (v: number) => number }> = [
  { key: 'max_expiration', title: 'Longest expiry', help: 'Shorter choices are offered automatically.', unit: 'days', toUi: (v) => +(v / 86400).toFixed(2), fromUi: (v) => Math.round(v * 86400) },
  { key: 'max_views', title: 'Most opens per link', unit: 'opens', toUi: (v) => v, fromUi: (v) => v },
  { key: 'max_file_size', title: 'File size', help: 'Per file.', unit: 'MB', toUi: (v) => Math.round(v / 1024 ** 2), fromUi: (v) => Math.round(v * 1024 ** 2) },
  { key: 'max_files', title: 'Files per link', unit: 'files', toUi: (v) => v, fromUi: (v) => v },
  { key: 'max_message_length', title: 'Message length', unit: 'characters', toUi: (v) => v, fromUi: (v) => v },
  { key: 'request_max_expiration', title: 'Longest request link', unit: 'days', toUi: (v) => +(v / 86400).toFixed(2), fromUi: (v) => Math.round(v * 86400) },
  { key: 'request_max_keep', title: 'Keep answers up to', unit: 'days', toUi: (v) => +(v / 86400).toFixed(2), fromUi: (v) => Math.round(v * 86400) },
  { key: 'audit_retention_days', title: 'Keep the audit log', unit: 'days', toUi: (v) => v, fromUi: (v) => v },
];

export function LimitsSection() {
  const { data, reload } = useServer<Limits>('/server/limits');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<Record<string, string>>({});
  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    if (!data) return out;
    for (const l of LIMIT_UI) {
      if (!(l.key in edits)) continue;
      const v = Number(edits[l.key]);
      const item = data.items[l.key];
      if (!edits[l.key].trim() || !Number.isFinite(v)) out[l.key] = 'Enter a number.';
      else if (l.fromUi(v) > item.max) out[l.key] = `Use ${l.toUi(item.max).toLocaleString()} ${l.unit}${l.key === 'max_file_size' ? ` (${bytes(item.max)})` : ''} or less.`;
      else if (l.fromUi(v) < item.min) out[l.key] = `Use at least ${l.toUi(item.min).toLocaleString()} ${l.unit}.`;
    }
    return { ...out, ...serverErr };
  }, [edits, data, serverErr]);
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
      <Heading title={t('server.limits')} lede="What people are offered in the Send and Request options." />
      {data && (
        <section class="card"><div class="card-b">
          {LIMIT_UI.map((l) => {
            const item = data.items[l.key];
            const value = edits[l.key] ?? String(l.toUi(item.value));
            const err = errors[l.key];
            return (
              <div class="set" key={l.key}>
                <div class="k"><b><label for={`lim-${l.key}`}>{l.title}</label></b>{(l.help || l.key === 'max_file_size') && <small>{l.help}{l.key === 'max_file_size' ? ` ${bytes(data.disk_free)} of disk is free.` : ''}</small>}</div>
                <div class="stack" style="gap:8px">
                  <div class={`input${err ? ' err' : ''}${item.locked_by ? ' locked' : ''}`} style="max-width:260px">
                    <input id={`lim-${l.key}`} class="bare" inputMode="decimal" value={value} disabled={!!item.locked_by || readOnly()} aria-invalid={!!err}
                      aria-describedby={err ? `lim-${l.key}-err` : undefined}
                      onInput={(e) => { setServerErr({}); setEdits({ ...edits, [l.key]: (e.target as HTMLInputElement).value }); }} />
                    <span class="unit">{l.unit}</span>
                  </div>
                  {err && <ErrMsg id={`lim-${l.key}-err`}>{err}</ErrMsg>}
                  {item.locked_by && <span class="lock"><Icon name="lock" size="sm" /><span>Set by <code>{item.locked_by}</code>. Change it in your Docker config.</span></span>}
                </div>
              </div>
            );
          })}
        </div></section>
      )}
      {changed.length > 0 && (
        <div class="savebar" role="region" aria-label="Unsaved changes">
          <span>{nErr ? `${nErr} ${nErr === 1 ? 'change has' : 'changes have'} an error` : t('server.unsaved', { n: changed.length })}</span>
          <div class="row">
            <button class="btn sm secondary" onClick={() => { setEdits({}); setServerErr({}); }}>{t('server.discard')}</button>
            <Btn kind="primary" class="sm" disabled={nErr > 0} loading={busy} onClick={save}>{t('server.save')}</Btn>
          </div>
        </div>
      )}
    </ServerShell>
  );
}

// ------------------------------------------------------------------ E4 branding
interface Branding { name: string; logo_url: string | null; public_url: string; name_locked_by: string | null; public_url_locked_by: string | null; logo_name: string | null }

export function BrandingSection() {
  const { data, reload } = useServer<Branding>('/server/branding');
  const [name, setName] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    setErr(null);
    if (!['image/svg+xml', 'image/png'].includes(f.type)) return setErr('Use an SVG or PNG file.');
    if (f.size > 256 * 1024) return setErr('Use a file of 256 KB or less.');
    try {
      await api('PUT', '/server/branding/logo', { bytes: new Uint8Array(await f.arrayBuffer()), headers: { 'Content-Type': f.type, 'X-File-Name': f.name } });
      toast('Logo updated');
      reload();
      void loadConfig();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const save = async () => {
    try {
      await api('PUT', '/server/branding', { body: { ...(name !== null ? { name } : {}), ...(url !== null ? { public_url: url } : {}) } });
      setName(null);
      setUrl(null);
      toast(t('server.saved'));
      reload();
      void loadConfig();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const shownName = name ?? data?.name ?? '';
  const host = (() => { try { return new URL(url ?? data?.public_url ?? '').host; } catch { return url ?? ''; } })();
  return (
    <ServerShell active="branding">
      <Heading title={t('server.branding')} lede="What recipients see. A familiar name makes a secret link look less like phishing." />
      {data && (
        <section class="card"><div class="card-b">
          <div class="set"><div class="k"><b><label for="b-name">Name</label></b></div>
            <div><input id="b-name" class="input" value={shownName} maxLength={40} disabled={!!data.name_locked_by || readOnly()} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
              {data.name_locked_by ? <div style="margin-top:8px"><Lock vars={data.name_locked_by} /></div> : <p class="help">Shown next to your logo, with “Secure share” after it.</p>}</div></div>
          <div class="set"><div class="k"><b>Logo</b><small>Square SVG or PNG, at least 64 px.</small></div>
            <div class="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f && !readOnly()) void upload(f); }}>
              {data.logo_url ? <img class="op-logo img lg" src={data.logo_url} alt="Current logo" /> : <span class="op-logo lg" aria-hidden="true">{(shownName || 'C')[0].toUpperCase()}</span>}
              <span class="small"><b>{data.logo_name ?? 'No logo yet'}</b><br /><span class="muted">Drop a new file or <button class="link" disabled={readOnly()} onClick={() => fileRef.current?.click()}>browse</button></span>
                {data.logo_url && !readOnly() && <> · <button class="link" onClick={async () => { await api('DELETE', '/server/branding/logo'); reload(); void loadConfig(); }}>Remove</button></>}</span>
              <input ref={fileRef} type="file" accept="image/svg+xml,image/png" class="sr" tabIndex={-1} aria-hidden="true" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void upload(f); }} />
            </div></div>
          <div class="set"><div class="k"><b><label for="b-url">Address</label></b><small>Shown with a lock on every recipient page.</small></div>
            <div><input id="b-url" class="input mono" value={url ?? data.public_url} disabled={!!data.public_url_locked_by || readOnly()} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
              {data.public_url_locked_by && <div style="margin-top:8px"><Lock vars={data.public_url_locked_by} /></div>}</div></div>
          <div class="set"><div class="k"><b>Preview</b></div>
            <div class="preview">
              <header class="hd">{shownName.trim() ? <span class="brand">{data.logo_url ? <img class="op-logo img" src={data.logo_url} alt="" /> : <span class="op-logo">{shownName.trim()[0].toUpperCase()}</span>}<span class="op-name">{shownName}</span><span class="op-sub">{t('app.brand_suffix')}</span></span>
                : <span class="brand"><Mark /><span class="wordmark">cryptex</span></span>}<span class="sp" /><span class="domain"><Icon name="lock" />{host}</span></header>
              <div style="padding:18px"><div class="sealed"><div class="sealed-top tint" style="height:76px"><span class="seal-badge"><Mark />{t('reveal.sealed')}</span></div>
                <div class="sealed-body" style="padding:16px 18px;gap:8px"><p class="from"><b>{config.value?.user?.name || 'Sam Rivera'}</b>{shownName ? ` at ${shownName}` : ''} sent you</p><p class="h3">Staging database</p></div></div></div>
            </div></div>
          {err && <ErrMsg>{err}</ErrMsg>}
        </div></section>
      )}
      {(name !== null || url !== null) && (
        <div class="savebar" role="region" aria-label="Unsaved changes"><span>{t('server.unsaved', { n: (name !== null ? 1 : 0) + (url !== null ? 1 : 0) })}</span>
          <div class="row"><button class="btn sm secondary" onClick={() => { setName(null); setUrl(null); }}>{t('server.discard')}</button><Btn kind="primary" class="sm" onClick={save}>{t('server.save')}</Btn></div></div>
      )}
    </ServerShell>
  );
}

// ------------------------------------------------------------------ E5 notifications
interface Hook { id: string; url: string; events: string[]; created_at: string; last_status: number | null; last_error: string | null; last_attempt_at: string | null; pending: number }
interface Notif { smtp: { enabled: boolean; host: string | null; port: number | null; from: string | null; tls: string | null }; webhooks: Hook[]; event_types: string[] }

export function NotificationsSection() {
  const { data, reload } = useServer<Notif>('/server/notifications');
  const [adding, setAdding] = useState(false);
  const [hookUrl, setHookUrl] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const add = async () => {
    setErr(null);
    try {
      const r = await api<{ signing_secret: string }>('POST', '/server/webhooks', { body: { url: hookUrl.trim() } });
      setSecret(r.signing_secret);
      setAdding(false);
      setHookUrl('');
      reload();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <ServerShell active="notifications">
      <Heading title={t('server.notifications')} lede="How Cryptex tells people a link was opened or a request answered." />
      {data && !data.smtp.enabled && <Banner kind="warn" icon="alert"><b>Email isn’t set up.</b> People can’t choose “Tell me when it’s opened” or limit a link to one email.</Banner>}
      {data && (
        <section class="card"><div class="card-b">
          <div class="set"><div class="k"><b>Email (SMTP)</b><small>Used for open notices and 6-digit codes.</small></div>
            <div class="stack">
              <div class="kv"><dt>Server</dt><dd class="mono">{data.smtp.host ? `${data.smtp.host}:${data.smtp.port ?? ''}` : '—'}</dd><dt>From</dt><dd class="mono">{data.smtp.from ?? '—'}</dd>
                <dt>Security</dt><dd>{data.smtp.tls === 'implicit' ? 'TLS' : data.smtp.tls === 'starttls' ? 'STARTTLS' : data.smtp.tls ? 'None' : '—'}</dd></div>
              <Lock vars="SMTP_URL, SMTP_FROM" />
              <Btn kind="secondary" class="" loading={testing} disabled={!data.smtp.enabled || readOnly()} onClick={async () => {
                setTesting(true);
                try { await api('POST', '/server/notifications/test-email', { body: {} }); toast(`Test email sent to ${config.value?.user?.email}`); } catch (e) { toast(errorText(e), 'error'); } finally { setTesting(false); }
              }}>{t('server.test_email')}</Btn>
            </div></div>
          <div class="set"><div class="k"><b>Webhooks</b><small>POST a signed JSON event to your tools. Payloads carry IDs and times, never contents.</small></div>
            <div class="stack">
              {data.webhooks.map((w) => (
                <div class="between hook" key={w.id}>
                  <span class="mono small ellip" title={w.url}>{w.url.replace(/^https:\/\//, '')}</span>
                  <span class="row">
                    {w.last_status === null ? <Status kind="waiting">No deliveries yet</Status> : w.last_status >= 200 && w.last_status < 300 ? <Status kind="opened">Delivering</Status>
                      : <Status kind="danger">{w.last_error ?? 'Failing'}{w.pending ? ` · ${w.pending} retrying` : ''}</Status>}
                    {!readOnly() && <button class="btn icon sm ghost" aria-label={`Remove webhook ${w.url}`} title="Remove" onClick={async () => { await api('DELETE', `/server/webhooks/${w.id}`); reload(); }}><Icon name="trash" size="sm" /></button>}
                  </span>
                </div>
              ))}
              {adding ? (
                <form class="row nowrap" onSubmit={(e) => { e.preventDefault(); void add(); }}>
                  <input class="input mono grow" type="url" placeholder="https://hooks.slack.com/services/…" value={hookUrl} data-autofocus aria-label="Webhook URL" onInput={(e) => setHookUrl((e.target as HTMLInputElement).value)} />
                  <Btn type="submit" kind="primary">Add</Btn>
                </form>
              ) : !readOnly() && <button class="btn sm ghost" style="justify-self:start" onClick={() => setAdding(true)}><Icon name="plus" size="sm" />Add webhook</button>}
              {err && <ErrMsg>{err}</ErrMsg>}
              <p class="fine">Slack incoming-webhook URLs get a short text message automatically. Others get the JSON payload with a <span class="mono">Cryptex-Signature</span> header.</p>
            </div></div>
        </div></section>
      )}
      <Dialog open={!!secret} onClose={() => setSecret(null)} labelledBy="whs" footer={<button class="btn primary" onClick={() => setSecret(null)}>{t('server.token_ack')}</button>}>
        <h2 class="h2" id="whs">Copy the signing secret now</h2>
        <p class="muted">Use it to check the <span class="mono">Cryptex-Signature</span> header. This is the only time it’s shown.</p>
        <div class="secret-once"><span>{secret}</span><Btn kind="primary" class="sm" icon="copy" onClick={() => copyText(secret!)}>{t('reveal.copy')}</Btn></div>
      </Dialog>
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
  const { data } = useServer<{ items: AuditRow[]; next: string | null }>(`/server/audit?${qs()}`);
  useEffect(() => {
    if (data) {
      setRows(data.items);
      setNext(data.next);
    }
  }, [data]);
  const more = async () => {
    const r = await api<{ items: AuditRow[]; next: string | null }>('GET', `/server/audit?${qs(next!)}`);
    setRows([...rows, ...r.items]);
    setNext(r.next);
  };
  const retention = config.value ? 365 : 365;
  return (
    <ServerShell active="audit">
      <Heading title={t('server.audit')} lede={`Every event, without contents. Kept ${retention} days.`}
        action={!readOnly() && <a class="btn secondary" href={`/api/v1/server/audit.csv?${qs()}`} download rel="external"><Icon name="down" size="sm" />{t('server.export_csv')}</a>} />
      <div class="row filters">
        <label class="input search" style="width:280px"><Icon name="search" size="sm" /><input class="bare" placeholder="Search people or link IDs" value={q} aria-label="Search people or link IDs"
          onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></label>
        <select class="chip select" value={type} aria-label="Event type" onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
          {EVENT_GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
        <select class="chip select" value={days} aria-label="Time range" onChange={(e) => setDays(Number((e.target as HTMLSelectElement).value))}>
          <option value={1}>Last 24 hours</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={0}>All time</option>
        </select>
      </div>
      <section class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Time</th><th>Event</th><th>By</th><th>Link</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={4} class="muted">No events match.</td></tr>}
          {rows.map((e) => <tr key={e.id}><td class="mono">{stamp(e.at)}</td><td>{eventText(e)}</td><td class={e.actor === 'link' || e.actor === 'system' ? 'muted' : ''}>{actorText(e)}</td><td class="mono">{e.item ?? '—'}</td></tr>)}
        </tbody>
      </table></div></section>
      {next && <button class="btn secondary" style="justify-self:center" onClick={more}>Load more</button>}
    </ServerShell>
  );
}

