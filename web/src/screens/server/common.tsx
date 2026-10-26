/** Server tab shell (E1–E8): owners only; in the demo, a read-only tour backed by fixtures. */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api } from '../../api/client';
import { t } from '../../lib/i18n';
import { config, toast } from '../../lib/state';
import { Banner, Btn, ErrMsg } from '../../ui/bits';
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
  { path: '/server/notifications', key: 'notifications', icon: 'bell' },
  { path: '/server/tokens', key: 'tokens', icon: 'terminal' },
  { path: '/server/audit', key: 'audit', icon: 'list' },
];

export function ServerShell({ active, children, attention }: { active: string; children: ComponentChildren; attention?: string[] }) {
  return (
    <Page header={<AppHeader active="server" />}>
      <div class="srv">
        <nav class="subnav" aria-label="Server">
          <span class="sh">{t('app.nav_server')}</span>
          {SECTIONS.map((s) => (
            <a key={s.key} href={s.path} class={active === s.key ? 'on' : ''} aria-current={active === s.key ? 'page' : undefined}>
              <Icon name={s.icon} size="sm" />{t(`server.${s.key}`)}{attention?.includes(s.key) && <span class="warn-dot" aria-label="Needs attention" />}
            </a>
          ))}
        </nav>
        <main class="srv-main" id="main">
          {config.value?.demo && <Banner kind="info" icon="info">This is a read-only tour with sample data. On your own server, owners manage everything here.</Banner>}
          {children}
        </main>
      </div>
    </Page>
  );
}

/** GET a server endpoint, or its fixture in the demo. */
export function useServer<T>(path: string): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (config.value?.demo) {
      setData((FIXTURES as Record<string, unknown>)[path.split('?')[0]] as T);
      return;
    }
    api<T>('GET', path).then(setData, (e) => setError(errorText(e)));
  }, [path, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export const readOnly = () => !!config.value?.demo;

// ------------------------------------------------------------------ re-authentication (5 minutes)
let openReauth: ((retry: () => Promise<void>) => void) | null = null;

/** Run a sensitive change; if the server asks to confirm identity, show the dialog and retry after. */
export async function sensitive(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'reauth_required' && openReauth) openReauth(fn);
    else toast(errorText(e), 'error');
  }
}

export function ReauthDialog() {
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  const user = config.value?.user;
  const close = () => setRetry(null);
  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('POST', '/auth/reauth', { body: { password, code } });
      const fn = retry!;
      close();
      await fn();
    } catch (e) {
      setErr((e as ApiError).status === 401 ? 'That didn’t match. Try again.' : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!retry} onClose={close} labelledBy="reauth-title"
      footer={<>
        <button class="btn secondary" onClick={close}>{t('send.cancel')}</button>
        {user?.sso
          ? <a class="btn primary" href={`/api/v1/auth/oidc/start?reauth=1&return_to=${encodeURIComponent(location.pathname)}`} rel="external">Continue with {config.value?.features.sso_name}</a>
          : <Btn kind="primary" loading={busy} onClick={confirm}>Confirm</Btn>}
      </>}>
      <h2 class="h3" id="reauth-title">{t('errors.reauth_required')}</h2>
      <p class="muted small">Changes to access, roles and other people’s tokens need a fresh confirmation. It lasts 5 minutes.</p>
      {!user?.sso && (
        <form class="stack" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
          <div><label class="label" for="ra-pw">{t('signin.password')}</label>
            <input id="ra-pw" class="input" type="password" autoComplete="current-password" value={password} data-autofocus onInput={(e) => setPassword((e.target as HTMLInputElement).value)} /></div>
          {user?.mfa && <div><label class="label" for="ra-code">{t('signin.totp')}</label>
            <input id="ra-code" class="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} /></div>}
          {err && <ErrMsg>{err}</ErrMsg>}
          <button type="submit" class="sr">Confirm</button>
        </form>
      )}
    </Dialog>
  );
}

export function Lock({ vars }: { vars: string }) {
  return <span class="lock"><Icon name="lock" size="sm" /><span>Set by {vars.split(',').map((v, i) => <span key={v}>{i ? ' and ' : ''}<code>{v.trim()}</code></span>)} in your environment</span></span>;
}

export function Heading({ title, lede, action }: { title: string; lede?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="between">
      <div class="stack" style="gap:6px"><h1 class="h1" tabIndex={-1} data-page-heading>{title}</h1>{lede && <p class="lede">{lede}</p>}</div>
      {action}
    </div>
  );
}
