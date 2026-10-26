/** /setup (F1): claim a fresh server with the code from its log, name it, choose who can create links. */
import { useEffect, useState } from 'preact/hooks';
import { api, setCsrf } from '../../api/client';
import { t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { config, loadConfig } from '../../lib/state';
import { Btn, ErrMsg, H1, Radio } from '../../ui/bits';
import { Brand } from '../../ui/chrome';
import { Icon, Mark } from '../../ui/icons';
import { errorText } from '../errors';

interface SetupInfo {
  needed: boolean;
  step: 1 | 2 | 3;
  detected_url: string;
  https: boolean;
  public_url_locked: boolean;
  brand_locked: boolean;
  sso: { enabled: boolean; name: string };
}

export function Setup() {
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [f, setF] = useState({ code: '', name: '', email: '', password: '', org: '', url: '', mode: 'signed_in' as 'anyone' | 'signed_in', sso: false });
  const [err, setErr] = useState<{ field?: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<SetupInfo>('GET', '/setup').then((i) => {
      if (!i.needed) {
        navigate('/', { replace: true });
        return;
      }
      setInfo(i);
      setStep(i.step);
      setF((x) => ({ ...x, url: i.detected_url, org: config.value?.brand.name ?? '', sso: i.sso.enabled }));
    });
  }, []);

  if (!info) return <main class="wizard" id="main" aria-busy="true" />;
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const host = (() => {
    try {
      return new URL(f.url).host;
    } catch {
      return f.url;
    }
  })();

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      const ae = e as { field?: string };
      setErr({ field: ae.field, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const submitOwner = () => run(async () => {
    const r = await api<{ next: string | null; csrf?: string }>('POST', '/setup/owner', {
      body: { setup_code: f.code.trim(), name: f.name.trim(), email: f.email.trim(), ...(f.sso ? { oidc: true } : { password: f.password }) },
    });
    if (r.next) {
      location.href = r.next;
      return;
    }
    setCsrf(r.csrf);
    await loadConfig();
    setStep(2);
  });
  const submitBrand = () => run(async () => {
    await api('POST', '/setup/brand', { body: { name: f.org.trim(), ...(info.public_url_locked ? {} : { public_url: f.url.trim() }) } });
    await loadConfig();
    setStep(3);
  });
  const submitAccess = () => run(async () => {
    await api('POST', '/setup/access', { body: { mode: f.mode } });
    await loadConfig();
    navigate('/server', { replace: true });
  });

  const steps = [t('setup.owner'), t('setup.brand'), t('setup.access')];
  const fieldErr = (name: string) => (err?.field === name || err?.field === `body.${name}` ? err.text : null);

  return (
    <>
      <header class="hd"><a class="brand" href="/"><Mark /><span class="wordmark">cryptex</span></a><span class="sp" /><span class="domain"><Icon name="lock" />Setting up {host}</span></header>
      <div class="wizard">
        <ol class="steps" style="align-content:start" aria-label="Setup steps">
          {steps.map((s, i) => {
            const n = i + 1;
            const state = n < step ? 'done' : n === step ? 'now' : 'todo';
            return <li class={`step ${state}`} key={s} aria-current={state === 'now' ? 'step' : undefined}>
              <span class="s">{state === 'done' ? <Icon name="check" /> : n}</span>{state === 'now' ? <b>{s}</b> : <span>{s}</span>}<span />
            </li>;
          })}
        </ol>
        <main class="stack" id="main" style="gap:20px">
          {step === 1 && (
            <form class="stack" style="gap:20px" onSubmit={(e) => { e.preventDefault(); void submitOwner(); }} noValidate>
              <div class="stack" style="gap:6px"><span class="eyebrow">{t('setup.step', { n: 1 })}</span><H1>Create the owner account</H1>
                <p class="lede">Owners can open the Server tab. Nobody can create links until an owner exists.</p></div>
              <div><label class="label" for="code">{t('setup.setup_code')}</label>
                <input id="code" class={`input mono${fieldErr('setup_code') ? ' err' : ''}`} value={f.code} autoComplete="off" spellcheck={false} data-autofocus placeholder="XXXX-XXXX-XXXX"
                  onInput={(e) => set({ code: (e.target as HTMLInputElement).value })} />
                {fieldErr('setup_code') ? <ErrMsg>{fieldErr('setup_code')}</ErrMsg> : <p class="help">{t('setup.setup_code_help')} Look for “setup code” in <span class="mono">docker logs</span>.</p>}</div>
              <div><label class="label" for="name">Your name</label>
                <input id="name" class="input" value={f.name} autoComplete="name" onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} /></div>
              <div><label class="label" for="email">{t('signin.email')}</label>
                <input id="email" class={`input${fieldErr('email') ? ' err' : ''}`} type="email" value={f.email} autoComplete="username" onInput={(e) => set({ email: (e.target as HTMLInputElement).value })} />
                {fieldErr('email') && <ErrMsg>{fieldErr('email')}</ErrMsg>}</div>
              {info.sso.enabled && (
                <div class="radios" role="radiogroup" aria-label="How you sign in">
                  <Radio name="how" on={f.sso} onSelect={() => set({ sso: true })} title={`Sign in with ${info.sso.name}`} help="Recommended. You’ll confirm with your account next." />
                  <Radio name="how" on={!f.sso} onSelect={() => set({ sso: false })} title="Use a password" help="For servers without single sign-on." />
                </div>
              )}
              {!f.sso && (
                <div><label class="label" for="password">{t('signin.password')}</label>
                  <input id="password" class={`input${fieldErr('password') ? ' err' : ''}`} type="password" value={f.password} autoComplete="new-password" minLength={12}
                    onInput={(e) => set({ password: (e.target as HTMLInputElement).value })} />
                  {fieldErr('password') ? <ErrMsg>{fieldErr('password')}</ErrMsg> : <p class="help">At least 12 characters. Turn on 2FA afterwards in the Server tab.</p>}</div>
              )}
              {err && !err.field && <ErrMsg>{err.text}</ErrMsg>}
              <div class="actions-m between"><span /><Btn type="submit" kind="primary" class="lg" loading={busy}>{t('setup.continue')}</Btn></div>
            </form>
          )}
          {step === 2 && (
            <form class="stack" style="gap:20px" onSubmit={(e) => { e.preventDefault(); void submitBrand(); }} noValidate>
              <div class="stack" style="gap:6px"><span class="eyebrow">{t('setup.step', { n: 2 })}</span><H1>{t('setup.brand_title')}</H1><p class="lede">{t('setup.brand_lede')}</p></div>
              <div><label class="label" for="org">{t('setup.org_name')}</label>
                <input id="org" class="input" value={f.org} maxLength={40} disabled={info.brand_locked} data-autofocus placeholder="Acme" onInput={(e) => set({ org: (e.target as HTMLInputElement).value })} /></div>
              <div><label class="label" for="url">{t('setup.address')}</label>
                <input id="url" class={`input mono${fieldErr('public_url') ? ' err' : ''}`} value={f.url} disabled={info.public_url_locked} onInput={(e) => set({ url: (e.target as HTMLInputElement).value })} />
                {fieldErr('public_url') ? <ErrMsg>{fieldErr('public_url')}</ErrMsg> : (
                  <p class={`help${f.url.startsWith('https://') ? '' : ' warn'}`}><Icon name={f.url.startsWith('https://') ? 'check' : 'alert'} size="sm" /> {f.url.startsWith('https://') ? t('setup.https_ok') : t('setup.https_missing')}</p>
                )}</div>
              <div class="preview">
                <header class="hd">{f.org.trim() ? <a class="brand"><span class="op-logo">{f.org.trim()[0].toUpperCase()}</span><span class="op-name">{f.org.trim()}</span><span class="op-sub">{t('app.brand_suffix')}</span></a> : <Brand />}<span class="sp" /><span class="domain"><Icon name="lock" />{host}</span></header>
                <div style="padding:16px 18px" class="muted small">This is the top of every page your recipients see.</div>
              </div>
              {err && !err.field && <ErrMsg>{err.text}</ErrMsg>}
              <div class="actions-m between"><span /><Btn type="submit" kind="primary" class="lg" loading={busy}>{t('setup.continue')}</Btn></div>
            </form>
          )}
          {step === 3 && (
            <form class="stack" style="gap:20px" onSubmit={(e) => { e.preventDefault(); void submitAccess(); }}>
              <div class="stack" style="gap:6px"><span class="eyebrow">{t('setup.step', { n: 3 })}</span><H1>Who can create links?</H1>
                <p class="lede">Opening a link and answering a request never need an account. You can change this later in the Server tab.</p></div>
              <div class="radios" role="radiogroup" aria-label={t('setup.access')}>
                <Radio name="mode" on={f.mode === 'anyone'} onSelect={() => set({ mode: 'anyone' })} title="Anyone who visits" help="Good on a private network. Rate limits still apply." />
                <Radio name="mode" on={f.mode === 'signed_in'} onSelect={() => set({ mode: 'signed_in' })} title="People who sign in" help="Recommended on the internet. People without an account can still answer requests." />
              </div>
              {err && <ErrMsg>{err.text}</ErrMsg>}
              <div class="actions-m between"><button type="button" class="btn ghost" onClick={() => setStep(2)}><Icon name="back" size="sm" />{t('setup.back')}</button>
                <Btn type="submit" kind="primary" class="lg" loading={busy}>Finish setup</Btn></div>
            </form>
          )}
        </main>
      </div>
    </>
  );
}
