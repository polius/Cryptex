/** /signin (F2): single sign-on for everyone; password + 2FA for owners without SSO. */
import { useState } from 'preact/hooks';
import { api, setCsrf } from '../../api/client';
import { t } from '../../lib/i18n';
import { navigate, route } from '../../lib/router';
import { cfg, loadConfig } from '../../lib/state';
import { Btn, ErrMsg, H1 } from '../../ui/bits';
import { Page, RecipientHeader } from '../../ui/chrome';
import { errorText } from '../errors';

const OIDC_ERRORS: Record<string, string> = {
  domain: 'That account isn’t allowed on this server. Use your work account.',
  email: 'Your account needs a verified email address.',
  expired: 'That sign-in took too long. Try again.',
  cancelled: 'Sign-in was cancelled.',
  provider: 'The sign-in provider returned something unexpected. Try again.',
  setup: 'This server isn’t set up yet.',
  reauth: 'Confirm with the same account you’re signed in with.',
};

export function safeNext(v: string | null): string {
  return v && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : '/';
}

export function SignIn() {
  const c = cfg();
  const brand = c.brand.name || 'This server';
  const next = safeNext(route.value.query.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(OIDC_ERRORS[route.value.query.get('error') ?? ''] ?? null);

  const done = async (csrf?: string) => {
    setCsrf(csrf);
    await loadConfig();
    navigate(next, { replace: true });
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (ticket) {
        const r = await api<{ csrf: string }>('POST', '/auth/login/totp', { body: { mfa_ticket: ticket, code: code.replace(/\s/g, '') } });
        await done(r.csrf);
      } else {
        const r = await api<{ mfa_ticket?: string; csrf?: string }>('POST', '/auth/login', { body: { email, password } });
        if (r.mfa_ticket) setTicket(r.mfa_ticket);
        else await done(r.csrf);
      }
    } catch (e) {
      setErr(ticket ? t('errors.wrong_code', { tries: 4 }).split('.')[0] + '.' : (e as { status?: number }).status === 401 ? t('signin.wrong') : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page header={<RecipientHeader />}>
      <main class="main narrow" id="main" style="padding-top:72px">
        <div class="stack" style="gap:6px">
          <H1>{t('signin.title')}</H1>
          <p class="lede">{c.brand.name ? `${brand}’s secure share is for ${brand} people. ` : ''}<b>You don’t need an account to open a link</b> or answer a request.</p>
        </div>
        {err && <ErrMsg>{err}</ErrMsg>}
        {c.features.sso && !ticket && (
          <a class="btn secondary lg full" href={`/api/v1/auth/oidc/start?return_to=${encodeURIComponent(next)}`} rel="external">
            <span class="oidc">{t('signin.sso', { provider: c.features.sso_name })}</span>
          </a>
        )}
        {c.features.password_sign_in && (
          <form class="stack" onSubmit={submit} noValidate>
            {c.features.sso && !ticket && <div class="or">{t('signin.or_owners')}</div>}
            {!ticket ? (
              <>
                <div><label class="label" for="email">{t('signin.email')}</label>
                  <input id="email" class="input" type="email" autoComplete="username" value={email} placeholder="you@company.com" required
                    data-autofocus={!c.features.sso || undefined} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} /></div>
                <div><label class="label" for="password">{t('signin.password')}</label>
                  <input id="password" class="input" type="password" autoComplete="current-password" value={password} required
                    onInput={(e) => setPassword((e.target as HTMLInputElement).value)} /></div>
              </>
            ) : (
              <div><label class="label" for="totp">{t('signin.totp')}</label>
                <input id="totp" class="input code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} data-autofocus
                  onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/[^0-9 ]/g, ''))} />
                <p class="help">From the authenticator app you set up for this server.</p></div>
            )}
            <Btn type="submit" kind="primary" class="lg full" loading={busy}>{t('signin.submit')}</Btn>
          </form>
        )}
        <p class="fine">Locked out? Run <span class="mono">cryptex owner reset</span> on the server.</p>
      </main>
    </Page>
  );
}
