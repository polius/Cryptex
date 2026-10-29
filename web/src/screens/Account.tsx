/** /account: what every signed-in person manages for themselves — password and 2FA. In the demo, a read-only tour
 *  with the sample owner. */
import { useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../api/client';
import { PASSWORD_MIN } from '../lib/format';
import { rich, t } from '../lib/i18n';
import { config, loadConfig, shownUser, toast } from '../lib/state';
import { Banner, Btn, ErrMsg, H1 } from '../ui/bits';
import { AppHeader, Page } from '../ui/chrome';
import { confirmDialog } from '../ui/confirm';
import { Dialog } from '../ui/dialog';
import { TotpEnroll, type TotpSetup } from '../ui/totp';
import { errorText } from './errors';
import { sensitive } from './server/common';

export function Account() {
  const user = shownUser()!;
  const demo = !!config.value?.demo;
  const [totp, setTotp] = useState<TotpSetup | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const totpFrom = useRef<HTMLElement | null>(null);
  const has2fa = !!user.totp;
  // The server asks to confirm identity (403 reauth_required) before it hands out the new app's key, so the
  // question comes first, never after a one-time code was typed; sensitive() shows the dialog and asks again.
  const start2fa = async (e: MouseEvent) => {
    totpFrom.current = e.currentTarget as HTMLElement; // now: busy, the button is disabled and focus falls to the page
    setStarting(true);
    await sensitive(async () => setTotp(await api<TotpSetup>('POST', '/me/totp')));
    setStarting(false);
  };
  const turnOff2fa = async () => {
    if (!await confirmDialog({ title: t('access.turn_off_title'), body: t('access.turn_off_body'), confirm: t('access.turn_off_confirm'), danger: true })) return;
    await sensitive(async () => {
      await api('DELETE', '/me/totp');
      await loadConfig();
      toast(t('access.totp_off'));
      // Focus stays on the 2FA button (now Turn on), not the top of the page.
      requestAnimationFrame(() => document.activeElement === document.body && document.getElementById('acct-2fa')?.focus());
    });
  };
  return (
    <Page header={<AppHeader />}>
      <main class="main" id="main">
        {demo && <Banner kind="demo" icon="info">{t('account.demo_tour')}</Banner>}
        <div class="stack" style="gap:6px"><H1>{t('account.title')}</H1>
          <p class="lede">{rich('account.lede', { username: <b>{user.username}</b> })}</p></div>
        <section class="card"><div class="card-b">
          <div class="set"><div class="k"><b>{t('signin.password')}</b><small>{t('account.password_help')}</small></div>
            <div class="row"><Btn kind="secondary" icon="key" disabled={demo} onClick={() => setPwOpen(true)}>{t('access.change_password')}</Btn></div></div>
          <div class="set"><div class="k"><b>{t('account.totp')}</b><small>{has2fa ? t('account.totp_on_help') : t('account.totp_off_help')}</small></div>
            <div class="row">
              {has2fa ? <Btn kind="secondary" class="danger" id="acct-2fa" disabled={demo} onClick={turnOff2fa}>{t('access.turn_off_2fa')}</Btn>
                : <Btn kind="secondary" icon="shield" id="acct-2fa" disabled={demo} loading={starting} onClick={start2fa}>{t('access.turn_on_2fa')}</Btn>}
            </div></div>
        </div></section>
      </main>
      {pwOpen && <PasswordDialog onClose={() => setPwOpen(false)} />}
      {totp && <TotpDialog setup={totp} returnTo={totpFrom.current} onClose={() => setTotp(null)} />}
    </Page>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // Enter and a click together try the current password once
  const save = async () => {
    if (inFlight.current) return;
    setErr(null);
    if (next.length < PASSWORD_MIN) return setErr(t('access.password_short'));
    inFlight.current = true;
    setBusy(true);
    try {
      // Both passwords stay on this page: the server gets keys derived from them, and the vault key re-wrapped.
      const v = await import('../store/vault');
      const b = await api<{ salt: string; kdf: { m: number; t: number; p: number } }>('GET', '/me/vault/keys');
      const current = await v.deriveAccount(cur, b.salt, b.kdf);
      const fresh = await v.newPassword(next);
      const vaultPw = await v.wrapForNewPassword(current.authKey, fresh.wrap); // checks the current password first
      await api('PUT', '/me/password', { body: { current_auth_key: current.authKey, new: { salt: fresh.salt, auth_key: fresh.authKey }, vault_pw: vaultPw } });
      toast(t('access.password_changed'));
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'wrong_password' ? t('errors.current_password') : errorText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} labelledBy="pw-title" footer={<><button class="btn secondary" onClick={onClose}>{t('send.cancel')}</button><Btn type="submit" form="pw-form" kind="primary" loading={busy}>{t('access.change_password')}</Btn></>}>
      <h2 class="h3" id="pw-title">{t('access.password_title')}</h2>
      <form class="stack" id="pw-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div><label class="label" for="pw-cur">{t('access.password_current')}</label><input id="pw-cur" class="input" type="password" autoComplete="current-password" value={cur} data-autofocus
          aria-describedby={err ? 'pw-err' : undefined} onInput={(e) => setCur((e.target as HTMLInputElement).value)} /></div>
        <div><label class="label" for="pw-new">{t('access.password_new')}</label><input id="pw-new" class="input" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} value={next}
          aria-describedby={err ? 'pw-help pw-err' : 'pw-help'} onInput={(e) => setNext((e.target as HTMLInputElement).value)} />
          <p class="help" id="pw-help">{t('access.password_help')}</p></div>
        {err && <ErrMsg id="pw-err">{err}</ErrMsg>}
      </form>
    </Dialog>
  );
}

/** Turn 2FA on. A new app: turn it off, then on again. */
function TotpDialog({ setup, returnTo, onClose }: { setup: TotpSetup; returnTo: HTMLElement | null; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // Enter in the code field and a click together check the code once
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    await sensitive(async () => {
      try {
        await api('PUT', '/me/totp', { body: { secret: setup.secret, code } });
        await loadConfig();
        toast(t('access.totp_on'));
        onClose();
      } catch (e) {
        if ((e as { code?: string }).code === 'reauth_required') throw e;
        setErr(errorText(e));
      }
    });
    inFlight.current = false;
    setBusy(false);
  };
  return (
    <Dialog open onClose={onClose} labelledBy="totp-title" returnTo={returnTo} footer={<><button class="btn secondary" onClick={onClose}>{t('send.cancel')}</button><Btn kind="primary" disabled={code.length !== 6} loading={busy} onClick={confirm}>{t('access.turn_on_2fa')}</Btn></>}>
      <h2 class="h3" id="totp-title">{t('access.turn_on_2fa')}</h2>
      <p class="muted small">{t('access.totp_on_body')}</p>
      <TotpEnroll setup={setup} code={code} onCode={setCode} error={err} onEnter={confirm} />
    </Dialog>
  );
}

