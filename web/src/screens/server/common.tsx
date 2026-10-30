/** Server tab shell (E1–E8): owners only; in the demo, a read-only tour backed by fixtures. */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ApiError, api } from '../../api/client';
import { LOCALE, rich, t } from '../../lib/i18n';
import { config, toast } from '../../lib/state';
import { Banner, Btn, ErrMsg, PasswordInput } from '../../ui/bits';
import { AppHeader, Page } from '../../ui/chrome';
import { Dialog } from '../../ui/dialog';
import { Icon, type IconName } from '../../ui/icons';
import { errorText } from '../errors';
import { FIXTURES } from './fixtures';

export const SECTIONS: Array<{ path: string; key: string; icon: IconName }> = [
  { path: '/server', key: 'overview', icon: 'gauge' },
  { path: '/server/access', key: 'access', icon: 'users' },
  { path: '/server/limits', key: 'limits', icon: 'sliders' },
  { path: '/server/branding', key: 'branding', icon: 'brush' },
  { path: '/server/audit', key: 'audit', icon: 'list' },
];

export function ServerShell({ active, children, attention }: { active: string; children: ComponentChildren; attention?: string[] }) {
  // On a phone the sections fold into a picker that shows the current one; on wider screens they're a sidebar.
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [active]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  const cur = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0];
  return (
    <Page header={<AppHeader active="server" />}>
      <div class="srv">
        <nav class={`subnav${open ? ' open' : ''}`} aria-label={t('app.nav_server')}>
          <span class="sh">{t('app.nav_server')}</span>
          <button type="button" class="subnav-pick" aria-expanded={open} aria-controls="srv-sections" onClick={() => setOpen(!open)}>
            <Icon name={cur.icon} size="sm" /><span class="grow">{t(`server.${cur.key}`)}</span>
            {!!attention?.length && <span class="warn-dot" aria-label={t('server.needs_attention')} />}
            <Icon name="chev" size="sm" class="chev" />
          </button>
          {open && <div class="menu-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
          <div class="subnav-list" id="srv-sections">
            {SECTIONS.map((s) => (
              <a key={s.key} href={s.path} class={active === s.key ? 'on' : ''} aria-current={active === s.key ? 'page' : undefined} onClick={() => setOpen(false)}>
                <Icon name={s.icon} size="sm" />{t(`server.${s.key}`)}{attention?.includes(s.key) && <span class="warn-dot" aria-label={t('server.needs_attention')} />}
              </a>
            ))}
          </div>
        </nav>
        <main class="srv-main" id="main">
          {config.value?.demo && <Banner kind="demo" icon="info">{t('server.demo_tour')}</Banner>}
          {children}
        </main>
      </div>
    </Page>
  );
}

/** GET a server endpoint, or its fixture in the demo. `loading` is true while a request is out (the last data stays). */
export function useServer<T>(path: string): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (config.value?.demo) {
      setData((FIXTURES as Record<string, unknown>)[path.split('?')[0]] as T);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api<T>('GET', path).then((d) => live && setData(d), (e) => live && setError(errorText(e))).finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

export const readOnly = () => !!config.value?.demo;

/** A section that couldn't load: what went wrong, and a way to try again (instead of an empty page). */
export function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return <Banner kind="danger" icon="alert" action={<Btn kind="secondary" class="sm" icon="refresh" onClick={retry}>{t('send.try_again')}</Btn>}>{error}</Banner>;
}

// ------------------------------------------------------------------ re-authentication (5 minutes)
// The server alone decides when identity must be confirmed (403 reauth_required): this tab keeps no clock of its own.
let openReauth: ((retry: () => Promise<void>) => void) | null = null;

/** Run a sensitive change; if the server asks to confirm identity, show the dialog and run it again after. A failure
 *  of the retry is reported the same way (a toast), not lost in the closed dialog. */
export async function sensitive(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'reauth_required' && openReauth) openReauth(() => sensitive(fn));
    else toast(errorText(e), 'error');
  }
}

export function ReauthDialog() {
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // Enter and a click together must not spend two tries
  useEffect(() => {
    openReauth = (fn) => {
      setErr(null);
      setPassword('');
      setCode('');
      setRetry(() => fn);
    };
    return () => {
      openReauth = null;
    };
  }, []);
  const close = () => setRetry(null);
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      const v = await import('../../store/vault');
      const b = await api<{ salt: string; kdf: { m: number; t: number; p: number } }>('GET', '/me/vault/keys');
      const { authKey } = await v.deriveAccount(password, b.salt, b.kdf); // the password itself is never sent
      await api('POST', '/auth/reauth', { body: { auth_key: authKey, code: code.replace(/\s/g, '') } });
      const fn = retry!;
      close();
      await fn();
    } catch (e) {
      // 401: wrong password or code. Anything else (a rate limit, offline) says what it is.
      setErr(e instanceof ApiError && e.status === 401 ? t('server.reauth_wrong') : errorText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!retry} onClose={close} labelledBy="reauth-title"
      footer={<>
        <button class="btn secondary" onClick={close}>{t('send.cancel')}</button>
        <Btn type="submit" form="ra-form" kind="primary" loading={busy}>{t('server.confirm')}</Btn>
      </>}>
      <h2 class="h3" id="reauth-title">{t('errors.reauth_required')}</h2>
      <p class="muted small">{t('server.reauth_body')}</p>
      <form class="stack" id="ra-form" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
        <div><label class="label" for="ra-pw">{t('signin.password')}</label>
          <PasswordInput id="ra-pw" autoComplete="current-password" value={password} data-autofocus aria-describedby={err ? 'ra-err' : undefined}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)} /></div>
        {config.value?.user?.totp !== false && <div><label class="label" for="ra-code">{t('signin.totp')}</label>
          <input id="ra-code" class="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} aria-describedby={err ? 'ra-err' : undefined}
            onInput={(e) => setCode((e.target as HTMLInputElement).value)} /></div>}
        {err && <ErrMsg id="ra-err">{err}</ErrMsg>}
      </form>
    </Dialog>
  );
}

/** Unsaved changes: Discard and Save. Either one makes the bar go away with the button that had focus, so focus goes
 *  back to `back()` (the field that was edited), or to the page heading when that field can't take it. */
export function SaveBar({ summary, busy, invalid, onDiscard, onSave, back }: {
  summary: string; busy: boolean; invalid?: boolean; onDiscard: () => void; onSave: () => void; back: () => HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inside = useRef(false); // focus is (or was last) in the bar: a disabled or removed button drops it on <body>
  const target = useRef(back);
  target.current = back;
  useLayoutEffect(() => () => {
    if (!inside.current && !ref.current?.contains(document.activeElement)) return;
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected) return; // the person already moved on
      const el = target.current();
      if (el && el.isConnected && !el.matches(':disabled')) el.focus();
      if (document.activeElement !== el) document.querySelector<HTMLElement>('[data-page-heading]')?.focus();
    });
  }, []);
  return (
    <div class="savebar" ref={ref} role="region" aria-label={t('server.unsaved_changes')}
      onFocusIn={() => (inside.current = true)}
      onFocusOut={(e) => { if (e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) inside.current = false; }}>
      <span>{summary}</span>
      <div class="row">
        <button class="btn sm secondary" onClick={onDiscard}>{t('server.discard')}</button>
        <Btn kind="primary" class="sm" disabled={invalid} loading={busy} onClick={onSave}>{t('server.save')}</Btn>
      </div>
    </div>
  );
}

export function Lock({ vars }: { vars: string }) {
  // "A and B", with each variable name in <code>.
  const names = vars.split(',').map((v) => v.trim());
  const list = new Intl.ListFormat(LOCALE, { type: 'conjunction' }).formatToParts(names)
    .map((p, i) => (p.type === 'element' ? <code key={i}>{p.value}</code> : p.value));
  return <span class="lock"><Icon name="lock" size="sm" /><span>{rich('server.locked_by_env', { vars: <>{list}</> })}</span></span>;
}

export function Heading({ title, lede, action }: { title: string; lede?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="between">
      <div class="stack" style="gap:6px"><h1 class="h1" tabIndex={-1} data-page-heading>{title}</h1>{lede && <p class="lede">{lede}</p>}</div>
      {action}
    </div>
  );
}
