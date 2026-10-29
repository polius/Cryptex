/** /reset#token: an owner's reset link. With the code they sent separately, choose a new password; the old 2FA is
 *  off, and a new authenticator can be set up here or later under Your account. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, setCsrf, type User } from '../../api/client';
import { dateTime, PASSWORD_MIN } from '../../lib/format';
import { rich, t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { loadConfig } from '../../lib/state';
import { Btn, ErrMsg, H1, PasswordInput, SharedCheck, useViewFocus } from '../../ui/bits';
import { Page, RecipientHeader } from '../../ui/chrome';
import { TotpEnroll, type TotpSetup } from '../../ui/totp';
import { errorText } from '../errors';
import type { Bundle } from '../../store/vault';

interface ResetInfo extends TotpSetup { username: string; by: string; expires_at: string; tries_left: number }

// Read once: the token leaves the address bar right away, so it isn't left in history.
const token = location.pathname === '/reset' ? location.hash.slice(1) : '';
if (token) history.replaceState(null, '', '/reset');

export function Reset() {
  const [info, setInfo] = useState<ResetInfo | null>(null);
  const [gone, setGone] = useState<string | null>(token ? null : t('reset.gone_body'));
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [use2fa, setUse2fa] = useState(true);
  const [shared, setShared] = useState(false);
  const [err, setErr] = useState<{ field?: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const goneText = (e: unknown) => {
    const ae = e as { code?: string; reason?: string };
    if (ae.code !== 'gone') return errorText(e);
    return ae.reason === 'reset_tries' ? t('reset.gone_tries_body') : t('reset.gone_body'); // too many wrong codes, or used, replaced or expired
  };

  useEffect(() => {
    if (token) api<ResetInfo>('POST', '/auth/reset', { body: { token } }).then(setInfo, (e) => setGone(goneText(e)));
  }, []);
  useViewFocus(gone ? 'gone' : info && 'form'); // the heading once the link has loaded

  const inFlight = useRef(false); // Enter in the code field also submits the form: one request, not two
  const submit = async () => {
    if (inFlight.current) return;
    setErr(null);
    if (code.replace(/[^0-9a-z]/gi, '').length !== 8) return setErr({ field: 'code', text: t('reset.code_short') });
    if (password.length < PASSWORD_MIN) return setErr({ field: 'password', text: t('setup.password_short') });
    inFlight.current = true;
    setBusy(true);
    try {
      const v = await import('../../store/vault');
      const pw = await v.newPassword(password); // the password itself is never sent
      const r = await api<{ csrf: string; user: User; vault: Bundle; shared?: boolean }>('POST', '/auth/reset/accept', {
        body: { token, code, salt: pw.salt, auth_key: pw.authKey, shared, ...(use2fa ? { totp_secret: info!.secret, totp_code: totp } : {}) },
      });
      setCsrf(r.csrf);
      // The old vault went with the old password: this makes a new one.
      await v.openAfterSignIn(r.user.id, pw.wrap, r.vault, { shared: r.shared ?? shared, authKey: pw.authKey });
      await loadConfig();
      navigate('/', { replace: true });
    } catch (e) {
      const ae = e as { field?: string; code?: string };
      if (ae.code === 'gone') setGone(goneText(e));
      else setErr({ field: ae.field, text: errorText(e) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const fe = (k: string) => (err?.field === k ? err.text : null);
  return (
    <Page header={<RecipientHeader />}>
      <main class="main narrow" id="main" style="padding-top:56px">
        {gone ? (
          <div class="stack"><div class="stack" style="gap:6px"><H1>{t('reset.gone_title')}</H1><p class="lede">{gone}</p></div>
            <div class="row"><a class="btn secondary" href="/signin">{t('app.nav_signin')}</a></div></div>
        ) : !info ? <div aria-busy="true" /> : (
          <form class="stack" style="gap:20px" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
            <div class="stack" style="gap:6px">
              <H1>{t('reset.title')}</H1>
              <p class="lede">{rich('reset.lede', { by: <b>{info.by}</b>, username: <b>{info.username}</b>, date: dateTime(info.expires_at) })}</p>
            </div>
            <input type="text" autoComplete="username" value={info.username} hidden readOnly />
            <div><label class="label" for="code">{t('reset.code')}</label>
              <input id="code" class={`input code${fe('code') ? ' err' : ''}`} autoComplete="one-time-code" autoCapitalize="characters" autoCorrect="off" spellcheck={false}
                maxLength={12} placeholder="XXXX-XXXX" value={code} data-autofocus aria-invalid={!!fe('code')} aria-describedby={fe('code') ? 'code-err' : 'code-help'}
                onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase())} />
              {fe('code') ? <ErrMsg id="code-err">{fe('code')}</ErrMsg> : <p class="help" id="code-help">{t('reset.code_help')}</p>}</div>
            <div><label class="label" for="password">{t('signin.new_password')}</label>
              <PasswordInput id="password" autoComplete="new-password" minLength={PASSWORD_MIN} value={password}
                aria-invalid={!!fe('password')} aria-describedby={fe('password') ? 'password-err' : 'password-help'} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} invalid={!!fe('password')} />
              {fe('password') ? <ErrMsg id="password-err">{fe('password')}</ErrMsg> : <p class="help" id="password-help">{t('invite.password_help')}</p>}</div>
            <label class="check"><input type="checkbox" checked={use2fa} onChange={(e) => setUse2fa((e.target as HTMLInputElement).checked)} />
              <span><b>{t('invite.use_2fa')}</b><small>{t('reset.totp_help')}</small></span></label>
            {use2fa && <TotpEnroll setup={info} code={totp} onCode={setTotp} error={fe('totp_code')} onEnter={() => void submit()} />}
            <SharedCheck checked={shared} onChange={setShared} />
            <p class="fine">{t('reset.links_note')}</p>
            {err && !['code', 'password', 'totp_code'].includes(err.field ?? '') && <ErrMsg>{err.text}</ErrMsg>}
            <Btn type="submit" kind="primary" class="lg full" loading={busy} disabled={use2fa && totp.length !== 6}>{t('invite.save_sign_in')}</Btn>
          </form>
        )}
      </main>
    </Page>
  );
}
