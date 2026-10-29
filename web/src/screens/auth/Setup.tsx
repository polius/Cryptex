/** /setup (F1): claim a fresh server with the code from its log, name it, choose who can create links, review and
 *  finish. The steps only ask: Finish does it all at once (POST /setup), so going back can change anything and a setup
 *  is never half done. The logo goes up right after, with the owner's new session, then the home page. 2FA is for later, in Your account. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, setCsrf, type User } from '../../api/client';
import { PASSWORD_MIN, USERNAME } from '../../lib/format';
import { t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { config, loadConfig, toast } from '../../lib/state';
import { Banner, Btn, Command, ErrMsg, H1, PasswordInput, Radio, useViewFocus } from '../../ui/bits';
import { BrandLockup, LanguagePicker, ThemePicker } from '../../ui/chrome';
import { Icon, Mark } from '../../ui/icons';
import { LogoDrop } from '../../ui/logo';
import { errorText } from '../errors';
import type { Bundle } from '../../store/vault';

interface SetupInfo {
  needed: boolean;
  brand_locked: boolean;
  access_locked: boolean;
  /** How to show the setup code on this server (the official image), or null: then it's only in the log. */
  code_command: string | null;
}

type Step = 1 | 2 | 3 | 4;

export function Setup() {
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [f, setF] = useState({ code: '', username: '', password: '', org: '', mode: 'signed_in' as 'anyone' | 'signed_in' });
  // The logo stays in this browser until Finish: a file and its preview.
  const [logo, setLogo] = useState<{ file: File; url: string } | null>(null);
  const inFlight = useRef(false);
  const [err, setErr] = useState<{ field?: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setLoadErr(null);
    api<SetupInfo>('GET', '/setup').then((i) => {
      if (!i.needed) {
        navigate('/', { replace: true });
        return;
      }
      setInfo(i);
      const c = config.value;
      setF((x) => ({ ...x, org: c?.brand.name ?? '', ...(i.access_locked && c ? { mode: c.mode } : {}) }));
    }, (e) => setLoadErr(errorText(e)));
  }, [attempt]);
  useEffect(() => () => { if (logo) URL.revokeObjectURL(logo.url); }, [logo]);
  // Each step replaces the last (a new <main>): the heading once loaded, then each step's first field.
  useViewFocus(info ? String(step) : loadErr && 'error');

  /** The steps sit in the middle of the header, so the step itself starts at the top of the page. */
  const header = (steps?: ComponentChildren) => (
    <header class="hd wizard-hd"><span class="brand"><Mark /><span class="wordmark">cryptex</span></span>{steps}<span class="sp" /><span class="hd-picks"><ThemePicker /><LanguagePicker /></span></header>
  );
  if (!info && loadErr) {
    return (
      <>
        {header()}
        <main class="main narrow" id="main" style="padding-top:72px">
          <H1>{t('boot.offline_title')}</H1>
          <Banner kind="danger" icon="alert">{loadErr}</Banner>
          <div class="row"><Btn kind="secondary" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>{t('send.try_again')}</Btn></div>
        </main>
      </>
    );
  }
  if (!info) return <main class="wizard" id="main" aria-busy="true" />;
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const go = (to: Step) => {
    setErr(null);
    setStep(to);
  };

  const run = async (fn: () => Promise<void>) => {
    if (inFlight.current) return; // Enter in the code field also submits the form
    inFlight.current = true;
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      const ae = e as { field?: string };
      setErr({ field: ae.field, text: errorText(e) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const submitOwner = () => {
    const problem = !f.code.trim() ? { field: 'setup_code', text: t('setup.err_code') }
      : !USERNAME.test(f.username.trim()) ? { field: 'username', text: t('setup.err_username') }
        : f.password.length < PASSWORD_MIN ? { field: 'password', text: t('setup.password_short') } : null;
    if (problem) {
      setErr(problem);
      document.getElementById(problem.field === 'setup_code' ? 'code' : problem.field)?.focus();
      return;
    }
    // The code is checked now, so a wrong one is caught before the rest is asked. Nothing is saved yet.
    return run(async () => {
      await api('POST', '/setup/check', { body: { setup_code: f.code.trim() } });
      setStep(2);
    });
  };
  const finish = () => run(async () => {
    const v = await import('../../store/vault');
    const pw = await v.newPassword(f.password); // the password itself is never sent
    const r = await api<{ csrf: string; user: User; vault: Bundle }>('POST', '/setup', {
      body: { setup_code: f.code.trim(), username: f.username.trim(), salt: pw.salt, auth_key: pw.authKey, brand_name: f.org.trim(), access: f.mode },
    }).catch((e: { field?: string }) => {
      if (e.field === 'setup_code' || e.field === 'username') setStep(1); // show it on the field it's about
      throw e;
    });
    setCsrf(r.csrf);
    await v.openAfterSignIn(r.user.id, pw.wrap, r.vault, { shared: false, authKey: pw.authKey });
    if (logo) {
      // Setup is done either way: a logo the server refuses can be added again in the Server tab.
      await api('PUT', '/server/branding/logo', { bytes: new Uint8Array(await logo.file.arrayBuffer()), headers: { 'Content-Type': logo.file.type, 'X-File-Name': logo.file.name } })
        .catch((e) => toast(errorText(e), 'error'));
    }
    await loadConfig();
    navigate('/', { replace: true });
  });

  const steps = [t('setup.owner'), t('setup.brand'), t('setup.access'), t('setup.overview')];
  const back = (to: Step) => (
    <button type="button" class="btn ghost" aria-label={t('setup.back')} onClick={() => go(to)}>
      <Icon name="back" size="sm" /><span class="hide-m">{t('setup.back')}</span></button>
  );
  const change = (to: Step) => <button type="button" class="btn sm ghost" onClick={() => go(to)}>{t('policy.change')}</button>;
  const fieldErr = (name: string) => (err?.field === name || err?.field === `body.${name}` ? err.text : null);
  const accessLocked = info.access_locked ? ' ' : undefined;

  return (
    <>
      {header(
        <ol class="stepper" aria-label={t('setup.steps_label')}>
          {steps.map((s, i) => {
            const n = i + 1;
            const state = n < step ? 'done' : n === step ? 'now' : 'todo';
            return <li class={state} key={s} aria-current={state === 'now' ? 'step' : undefined}>
              <span class="s" aria-hidden="true">{state === 'done' ? <Icon name="check" /> : n}</span><span class="l">{s}</span>
            </li>;
          })}
        </ol>,
      )}
      <div class="wizard">
        <main class="wizard-main" id="main" key={step}>
          {step === 1 && (
            <Panel n={1} title={t('setup.owner_title')} lede={t('setup.owner_lede')} onSubmit={() => void submitOwner()}
              next={<Btn type="submit" kind="primary" class="lg" loading={busy}>{t('setup.continue')}</Btn>}>
              <div><label class="label" for="code">{t('setup.setup_code')}</label>
                <input id="code" class={`input mono${fieldErr('setup_code') ? ' err' : ''}`} value={f.code} autoComplete="off" autoCapitalize="characters" spellcheck={false} data-autofocus placeholder="XXXX-XXXX-XXXX"
                  aria-invalid={!!fieldErr('setup_code')} aria-describedby={fieldErr('setup_code') ? 'code-err' : 'code-help'} onInput={(e) => set({ code: (e.target as HTMLInputElement).value })} />
                {fieldErr('setup_code') ? <ErrMsg id="code-err">{fieldErr('setup_code')}</ErrMsg> : <p class="help" id="code-help">{info.code_command ? t('setup.setup_code_run') : t('setup.setup_code_help')}</p>}
                {info.code_command && <Command text={info.code_command} skipTab />}</div>
              <div><label class="label" for="username">{t('signin.username')}</label>
                <input id="username" class={`input${fieldErr('username') ? ' err' : ''}`} value={f.username} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellcheck={false} maxLength={32}
                  aria-invalid={!!fieldErr('username')} aria-describedby={fieldErr('username') ? 'username-err' : 'username-help'} onInput={(e) => set({ username: (e.target as HTMLInputElement).value })} />
                {fieldErr('username') ? <ErrMsg id="username-err">{fieldErr('username')}</ErrMsg> : <p class="help" id="username-help">{t('signin.username_help')}</p>}</div>
              <div><label class="label" for="password">{t('signin.password')}</label>
                <PasswordInput id="password" value={f.password} autoComplete="new-password" minLength={PASSWORD_MIN} invalid={!!fieldErr('password')}
                  aria-invalid={!!fieldErr('password')} aria-describedby={fieldErr('password') ? 'password-err' : 'password-help'} onInput={(e) => set({ password: (e.target as HTMLInputElement).value })} />
                {fieldErr('password') ? <ErrMsg id="password-err">{fieldErr('password')}</ErrMsg> : <p class="help" id="password-help">{t('setup.password_help')}</p>}</div>
              {err && !err.field && <ErrMsg>{err.text}</ErrMsg>}
            </Panel>
          )}
          {step === 2 && (
            <Panel n={2} title={t('setup.brand_title')} lede={t('setup.brand_lede')} onSubmit={() => go(3)} back={back(1)}
              next={<Btn type="submit" kind="primary" class="lg">{t('setup.continue')}</Btn>}>
              <div><label class="label" for="org">{t('setup.org_name')}<span class="opt-tag">{t('common.optional')}</span></label>
                <input id="org" class="input" value={f.org} maxLength={40} disabled={info.brand_locked} data-autofocus placeholder={t('setup.org_placeholder')} onInput={(e) => set({ org: (e.target as HTMLInputElement).value })} /></div>
              <div><span class="label" id="logo-label">{t('branding.logo')}<span class="opt-tag">{t('common.optional')}</span></span>
                <LogoDrop logoUrl={logo?.url ?? null} logoName={logo?.file.name ?? null} onPick={(file) => setLogo(file && { file, url: URL.createObjectURL(file) })} />
                <p class="help">{t('branding.logo_help')}</p></div>
              <div class="preview">
                <header class="hd"><span class="brand"><BrandLockup name={f.org.trim()} logoUrl={logo?.url ?? null} /></span></header>
                <div class="preview-note muted small">{t('setup.preview_note')}</div>
              </div>
            </Panel>
          )}
          {step === 3 && (
            <Panel n={3} title={t('setup.access_title')} lede={t('setup.access_lede')} onSubmit={() => go(4)} validate back={back(2)}
              next={<Btn type="submit" kind="primary" class="lg">{t('setup.continue')}</Btn>}>
              <div class="radios" role="radiogroup" aria-label={t('setup.access')}>
                <Radio name="mode" on={f.mode === 'anyone'} onSelect={() => set({ mode: 'anyone' })} title={t('setup.access_anyone')} help={t('setup.access_anyone_help')} disabled={accessLocked} />
                <Radio name="mode" on={f.mode === 'signed_in'} onSelect={() => set({ mode: 'signed_in' })} title={t('setup.access_signed_in')} help={t('setup.access_signed_in_help')} disabled={accessLocked} />
              </div>
            </Panel>
          )}
          {step === 4 && (
            <Panel n={4} title={t('setup.review_title')} lede={t('setup.review_lede')} onSubmit={() => void finish()} back={back(3)}
              next={<Btn type="submit" kind="primary" class="lg" loading={busy}>{t('setup.finish')}</Btn>}>
              <dl class="summary">
                <div><dt>{t('setup.owner')}</dt><dd>{f.username.trim().toLowerCase()}</dd>{change(1)}</div>
                <div><dt>{t('setup.brand')}</dt><dd><span class="brand summary-brand"><BrandLockup name={f.org.trim()} logoUrl={logo?.url ?? null} /></span></dd>{change(2)}</div>
                <div><dt>{t('setup.access')}</dt><dd>{f.mode === 'anyone' ? t('setup.access_anyone') : t('setup.access_signed_in')}</dd>{change(3)}</div>
              </dl>
              {err && <ErrMsg>{err.text}</ErrMsg>}
            </Panel>
          )}
        </main>
      </div>
    </>
  );
}

/** One step: the heading centred over a card that holds the fields, with Back and Continue in the card's footer
 *  (a bar pinned to the bottom of the screen on phones). */
function Panel({ n, title, lede, onSubmit, validate, back, next, children }: {
  n: number; title: string; lede: string; onSubmit: () => void; validate?: boolean; back?: ComponentChildren; next: ComponentChildren; children: ComponentChildren;
}) {
  return (
    <>
      <div class="wizard-head"><span class="sr">{t('setup.step', { n })}</span><H1>{title}</H1><p class="lede">{lede}</p></div>
      <form class="wizard-card" onSubmit={(e) => { e.preventDefault(); onSubmit(); }} noValidate={!validate}>
        <div class="wizard-b">{children}</div>
        <div class="wizard-f actions-m">{back}{next}</div>
      </form>
    </>
  );
}
