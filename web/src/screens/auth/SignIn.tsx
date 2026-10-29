/** /signin (F2): password, then a code from the authenticator app (for those with 2FA). Accounts come from invite links.
 *  The password never leaves this page: it becomes an auth key (sent) and a wrap key (kept, opens the vault).
 *  Forgot it: the server leaves a temporary password for whoever runs it to read; signing in with that one skips
 *  the 2FA code and leads straight to choosing a new password (which turns 2FA off). */
import { useRef, useState } from 'preact/hooks';
import { api, ApiError, setCsrf, type User } from '../../api/client';
import { PASSWORD_MIN } from '../../lib/format';
import { rich, t } from '../../lib/i18n';
import { navigate, route } from '../../lib/router';
import { cfg, loadConfig } from '../../lib/state';
import { Btn, Command, ErrMsg, H1, PasswordInput, SharedCheck, useViewFocus } from '../../ui/bits';
import { Page, RecipientHeader } from '../../ui/chrome';
import { errorText } from '../errors';
import type { Bundle } from '../../store/vault';

export function safeNext(v: string | null): string {
  return v && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : '/';
}

export function SignIn() {
  const c = cfg();
  const next = safeNext(route.value.query.get('next'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [shared, setShared] = useState(false);
  const [view, setView] = useState<'signin' | 'forgot' | 'sent' | 'new'>('signin');
  const [sent, setSent] = useState<{ command: string | null; hours: number } | null>(null);
  const [resetTicket, setResetTicket] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wrap = useRef<Uint8Array | null>(null); // from the password; opens the vault once the code is right
  const authKey = useRef<string | null>(null); // the same password's auth key: vault writes prove it with this
  // Each step replaces the last in place: its first field takes focus (the password when the username is filled in).
  useViewFocus(view === 'signin' && ticket ? 'code' : view);

  /** Signed in. `shared` is the server's word for this session ("This is a shared computer", kept on the ticket
   *  through the 2FA step), which decides whether this browser may keep anything. */
  const done = async (r: SignedIn) => {
    setCsrf(r.csrf);
    const v = await import('../../store/vault');
    await v.openAfterSignIn(r.user.id, wrap.current!, r.vault, { shared: r.shared ?? shared, authKey: authKey.current ?? undefined });
    wrap.current = null;
    authKey.current = null;
    await loadConfig();
    navigate(next, { replace: true });
  };

  type SignedIn = { csrf: string; user: User; vault: Bundle; shared?: boolean };
  type Step = { mfa_ticket: string } | { reset_ticket: string } | SignedIn;
  const advance = async (r: Step) => {
    if ('mfa_ticket' in r) setTicket(r.mfa_ticket);
    else if ('reset_ticket' in r) { // a temporary password: a new one before anything else
      wrap.current = null;
      authKey.current = null;
      setTicket(null);
      setCode('');
      setResetTicket(r.reset_ticket);
      setView('new');
    } else await done(r); // no 2FA on this account
  };

  const go = (v: typeof view) => {
    setErr(null);
    setPassword('');
    setTicket(null);
    setView(v);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setErr(null);
    if (view === 'new' && password.length < PASSWORD_MIN) return setErr(t('setup.password_short'));
    setBusy(true);
    try {
      if (view === 'forgot') {
        setSent(await api<{ command: string | null; hours: number }>('POST', '/auth/forgot', { body: { username } }));
        setView('sent');
      } else if (view === 'new') {
        const v = await import('../../store/vault');
        const pw = await v.newPassword(password); // the password itself is never sent
        wrap.current = pw.wrap;
        authKey.current = pw.authKey;
        await done(await api<SignedIn>('POST', '/auth/password/reset', { body: { reset_ticket: resetTicket, salt: pw.salt, auth_key: pw.authKey } }));
      } else if (ticket) {
        await advance(await api<Step>('POST', '/auth/login/totp', { body: { mfa_ticket: ticket, code: code.replace(/\s/g, '') } }));
      } else {
        const v = await import('../../store/vault');
        const pre = await api<{ salt: string; kdf: Bundle['kdf'] }>('POST', '/auth/prelogin', { body: { username } });
        const keys = await v.deriveAccount(password, pre.salt, pre.kdf);
        wrap.current = keys.wrap;
        authKey.current = keys.authKey;
        const r = await api<Step>('POST', '/auth/login', { body: { username, auth_key: keys.authKey, shared } });
        setPassword('');
        await advance(r);
      }
    } catch (e) {
      setErr(signInError(e, view === 'signin' ? (ticket ? 'code' : 'password') : view));
      const outOfTries = ticket && e instanceof ApiError && e.code === 'wrong_code' && e.triesLeft === 0;
      if (outOfTries || (e instanceof ApiError && e.code === 'sign_in_required' && (ticket || view === 'new'))) {
        // The step took too long, or that was its last try: start over from the password.
        wrap.current = null;
        authKey.current = null;
        setTicket(null);
        setCode('');
        setResetTicket(null);
        setPassword('');
        setView('signin'); // the username is still filled in: focus goes to the password
      }
    } finally {
      setBusy(false);
    }
  };

  const usernameField = (first: boolean) => (
    <div><label class="label" for="username">{t('signin.username')}</label>
      <input id="username" class="input" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellcheck={false} maxLength={32} value={username} required
        data-autofocus={first || undefined} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} /></div>
  );
  const back = <button type="button" class="link" onClick={() => go('signin')}>{t('signin.back')}</button>;
  if (!c.features.sign_in) { // the demo has no accounts: its send page is the way in
    navigate('/', { replace: true });
    return null;
  }

  if (view !== 'signin') {
    return (
      <Page header={<RecipientHeader />}>
        <main class="main narrow" id="main" style="padding-top:72px">
          {view === 'sent' && sent ? (
            <div class="stack">
              <div class="stack" style="gap:6px">
                <H1>{t('signin.sent_title')}</H1>
                <p class="lede">{rich(sent.command ? 'signin.sent_body' : 'signin.sent_body_folder', { username: <b>{username.trim().toLowerCase()}</b>, hours: sent.hours })}</p>
                {sent.command && <Command text={sent.command} />}
              </div>
              <p>{t('signin.sent_next')}</p>
              <Btn kind="primary" class="lg full" onClick={() => go('signin')}>{t('signin.back')}</Btn>
            </div>
          ) : (
            <form class="stack" onSubmit={submit} noValidate>
              <div class="stack" style="gap:6px">
                <H1>{view === 'new' ? t('signin.new_title') : t('signin.forgot_title')}</H1>
                <p class="lede">{view === 'new' ? t('signin.new_lede') : t('signin.forgot_lede')}</p>
              </div>
              {err && <ErrMsg>{err}</ErrMsg>}
              {view === 'new' ? (
                <>
                  <input type="text" autoComplete="username" value={username.trim().toLowerCase()} hidden readOnly />
                  <div><label class="label" for="password">{t('signin.new_password')}</label>
                    <PasswordInput id="password" autoComplete="new-password" minLength={PASSWORD_MIN} value={password} data-autofocus
                      onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
                    <p class="help">{t('invite.password_help')}</p></div>
                  <p class="fine">{t('reset.links_note')}</p>
                </>
              ) : usernameField(true)}
              <Btn type="submit" kind="primary" class="lg full" loading={busy}>{view === 'new' ? t('signin.new_submit') : t('signin.forgot_submit')}</Btn>
              {view === 'forgot' && <p class="fine">{back}</p>}
            </form>
          )}
        </main>
      </Page>
    );
  }

  return (
    <Page header={<RecipientHeader />}>
      <main class="main narrow" id="main" style="padding-top:72px">
        <div class="stack" style="gap:6px">
          <H1>{t('signin.title')}</H1>
          <p class="lede">{c.brand.name
            ? rich('signin.lede_rich', { brand: c.brand.name, no_account: <b>{t('signin.no_account_needed')}</b> })
            : <b>{t('signin.no_account_needed')}</b>}</p>
        </div>
        {err && <ErrMsg id="signin-err">{err}</ErrMsg>}
        <form class="stack" onSubmit={submit} noValidate>
          {!ticket ? (
            <>
              {usernameField(!username)}
              <div><label class="label" for="password">{t('signin.password')}</label>
                <PasswordInput id="password" autoComplete="current-password" value={password} required data-autofocus={!!username || undefined}
                  aria-describedby={err ? 'signin-err' : undefined} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} /></div>
              <SharedCheck checked={shared} onChange={setShared} />
            </>
          ) : (
            <div><label class="label" for="totp">{t('signin.totp')}</label>
              <input id="totp" class={`input code${err ? ' err' : ''}`} inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} data-autofocus
                aria-invalid={!!err} aria-describedby={err ? 'signin-err totp-help' : 'totp-help'}
                onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/[^0-9 ]/g, ''))} />
              <p class="help" id="totp-help">{t('signin.totp_help')}</p></div>
          )}
          <Btn type="submit" kind="primary" class="lg full" loading={busy}>{t('signin.submit')}</Btn>
        </form>
        {ticket
          ? <p class="fine">{back}</p>
          : <p class="fine"><button type="button" class="link" onClick={() => go('forgot')}>{t('signin.forgot')}</button></p>}
        {!ticket && c.mode === 'anyone' && <p class="fine"><a class="link" href="/">{t('signin.send_without')}</a></p>}
        {!ticket && <p class="fine muted">{t('signin.locked_out')}</p>}
      </main>
    </Page>
  );
}

/** Sign-in errors in the words of the step they happen at. */
function signInError(e: unknown, step: 'password' | 'code' | 'forgot' | 'new' | 'sent'): string {
  if (!(e instanceof ApiError)) return errorText(e);
  if (step === 'password' && e.status === 401) return t('signin.wrong');
  if (step === 'code') {
    if (e.code === 'sign_in_required') return t('signin.expired'); // the ticket ran out: back to the password
  }
  if (step === 'new' && e.code === 'sign_in_required') return t('signin.expired');
  return errorText(e); // wrong_code says how many tries are left
}
