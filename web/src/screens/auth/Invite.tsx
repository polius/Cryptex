/** /invite#token: set a password and an authenticator app from a one-time link an owner shared. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, setCsrf, type User } from '../../api/client';
import { PASSWORD_MIN } from '../../lib/format';
import { rich, t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { cfg, loadConfig } from '../../lib/state';
import { Btn, ErrMsg, H1, PasswordInput, SharedCheck, useViewFocus } from '../../ui/bits';
import { Page, RecipientHeader } from '../../ui/chrome';
import { TotpEnroll, type TotpSetup } from '../../ui/totp';
import { errorText } from '../errors';
import type { Bundle } from '../../store/vault';

interface Invite extends TotpSetup { username: string; role: 'member' | 'owner'; reset: boolean }

// Read once: the token leaves the address bar right away, so it isn't left in history.
const token = location.pathname === '/invite' ? location.hash.slice(1) : '';
if (token) history.replaceState(null, '', '/invite');
const goneText = (e: unknown) => ((e as { code?: string }).code === 'gone' ? t('invite.gone_body') : errorText(e));

export function Invite() {
  const brand = cfg().brand.name;
  const [inv, setInv] = useState<Invite | null>(null);
  const [gone, setGone] = useState<string | null>(token ? null : t('invite.incomplete'));
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [use2fa, setUse2fa] = useState(true);
  const [shared, setShared] = useState(false);
  const [err, setErr] = useState<{ field?: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token) api<Invite>('POST', '/auth/invite', { body: { token } }).then(setInv, (e) => setGone(goneText(e)));
  }, []);
  useViewFocus(gone ? 'gone' : inv && 'form'); // the heading once the invite has loaded

  const inFlight = useRef(false); // Enter in the code field also submits the form: one request, not two
  const submit = async () => {
    if (inFlight.current) return;
    setErr(null);
    if (password.length < PASSWORD_MIN) return setErr({ field: 'password', text: t('setup.password_short') });
    inFlight.current = true;
    setBusy(true);
    try {
      const v = await import('../../store/vault');
      const pw = await v.newPassword(password); // the password itself is never sent
      const r = await api<{ csrf: string; user: User; vault: Bundle; shared?: boolean }>('POST', '/auth/invite/accept', {
        body: { token, salt: pw.salt, auth_key: pw.authKey, shared, ...(use2fa ? { totp_secret: inv!.secret, totp_code: code } : {}) },
      });
      setCsrf(r.csrf);
      await v.openAfterSignIn(r.user.id, pw.wrap, r.vault, { shared: r.shared ?? shared, authKey: pw.authKey });
      await loadConfig();
      navigate('/', { replace: true });
    } catch (e) {
      const ae = e as { field?: string; code?: string };
      if (ae.code === 'gone') setGone(t('invite.gone_body'));
      else setErr({ field: ae.field, text: errorText(e) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Page header={<RecipientHeader />}>
      <main class="main narrow" id="main" style="padding-top:56px">
        {gone ? (
          <div class="stack"><div class="stack" style="gap:6px"><H1>{t('invite.gone_title')}</H1><p class="lede">{gone}</p></div>
            <div class="row"><a class="btn secondary" href="/signin">{t('app.nav_signin')}</a></div></div>
        ) : !inv ? <div aria-busy="true" /> : (
          <form class="stack" style="gap:20px" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
            <div class="stack" style="gap:6px">
              <H1>{inv.reset ? t('invite.reset_title') : t('invite.welcome_name', { name: inv.username })}</H1>
              <p class="lede">{inv.reset ? t('invite.reset_lede')
                : rich(brand ? 'invite.joining' : 'invite.joining_no_brand', { brand, role: inv.role, username: <b>{inv.username}</b> })}</p>
            </div>
            <div><label class="label" for="password">{t('signin.password')}</label>
              <PasswordInput id="password" autoComplete="new-password" minLength={PASSWORD_MIN} value={password} data-autofocus
                aria-invalid={err?.field === 'password'} aria-describedby={err?.field === 'password' ? 'password-err' : 'password-help'}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)} invalid={err?.field === 'password'} />
              {err?.field === 'password' ? <ErrMsg id="password-err">{err.text}</ErrMsg> : <p class="help" id="password-help">{t('invite.password_help')}</p>}</div>
            <input type="text" autoComplete="username" value={inv.username} hidden readOnly />
            <label class="check"><input type="checkbox" checked={use2fa} onChange={(e) => setUse2fa((e.target as HTMLInputElement).checked)} />
              <span><b>{t('invite.use_2fa')}</b><small>{t('invite.use_2fa_help')}</small></span></label>
            {use2fa && <TotpEnroll setup={inv} code={code} onCode={setCode} error={err?.field === 'totp_code' ? err.text : null} onEnter={() => void submit()} />}
            <SharedCheck checked={shared} onChange={setShared} />
            {err && err.field !== 'password' && err.field !== 'totp_code' && <ErrMsg>{err.text}</ErrMsg>}
            <Btn type="submit" kind="primary" class="lg full" loading={busy} disabled={use2fa && code.length !== 6}>{inv.reset ? t('invite.save_sign_in') : t('invite.create_account')}</Btn>
          </form>
        )}
      </main>
    </Page>
  );
}
