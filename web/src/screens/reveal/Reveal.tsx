/** /s/:id#key (D1–D7). Loading changes nothing; Reveal is a click. The key never leaves this page. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { parseLinkFragment } from '../../crypto/format';
import { checkCode, loadMeta, report, reveal, startCode, type Opened, type Revealed } from '../../flows/reveal';
import { bytes, dateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { dropFragment } from '../../lib/router';
import { config, toast } from '../../lib/state';
import { Banner, Btn, ErrMsg, H1, Status } from '../../ui/bits';
import { host, Page, RecipientHeader } from '../../ui/chrome';
import { Icon, Mark } from '../../ui/icons';
import { errorText } from '../errors';
import { Output } from './Output';

type State =
  | { k: 'loading' }
  | { k: 'broken'; shown: string }
  | { k: 'missing' }
  | { k: 'gone'; reason: string; at?: string }
  | { k: 'sealed'; o: Opened }
  | { k: 'revealing'; o: Opened; pct: number }
  | { k: 'open'; o: Opened; data: Revealed }
  | { k: 'cleared' }
  | { k: 'error'; message: string };

/** Key read once on load, kept in memory only. */
let initialFragment: string | null = null;

export function Reveal({ id }: { id: string }) {
  const [s, setS] = useState<State>({ k: 'loading' });
  const [pass, setPass] = useState('');
  const [passShown, setPassShown] = useState(false);
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const K = useRef<Uint8Array | null>(null);

  useEffect(() => {
    const frag = initialFragment ?? location.hash.slice(1);
    initialFragment = frag;
    const key = parseLinkFragment(frag);
    if (!key) {
      setS({ k: 'broken', shown: `${host()}/s/${id}#${frag}` });
      return;
    }
    K.current = key;
    loadMeta(id, key).then((o) => setS({ k: 'sealed', o }), (e) => fail(e));
    return () => {
      initialFragment = null;
    };
  }, [id]);

  function fail(e: unknown) {
    if (e instanceof ApiError && e.code === 'gone') setS({ k: 'gone', reason: e.reason ?? 'opened', at: e.at });
    else if (e instanceof ApiError && e.code === 'not_found') setS({ k: 'missing' });
    else setS({ k: 'error', message: errorText(e, 'the sender') });
  }

  const sender = (o: Opened) => o.from || 'Someone';
  const brand = config.value?.brand.name || host();

  async function doReveal(o: Opened, grant?: string) {
    setErr(null);
    setBusy(true);
    try {
      setS({ k: 'revealing', o, pct: 0 });
      const data = await reveal(id, K.current!, o, { passphrase: pass, grant }, (done, total) => setS({ k: 'revealing', o, pct: Math.round((100 * done) / total) }));
      dropFragment(); // the key leaves the address bar only now, so a refresh before reveal still works
      setS({ k: 'open', o, data });
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.out')?.focus());
    } catch (e) {
      setS({ k: 'sealed', o });
      if (e instanceof ApiError && e.code === 'wrong_passphrase') {
        setErr(t('errors.wrong_passphrase', { tries: e.triesLeft ?? 0, sender: sender(o) }));
        o.meta.tries_left = e.triesLeft;
      } else if (e instanceof ApiError && e.code === 'code_required') {
        setErr(t('errors.code_required'));
      } else if (e instanceof ApiError && e.code === 'sign_in_required') {
        location.href = `/api/v1/auth/oidc/start?return_to=${encodeURIComponent(location.pathname + location.hash)}`;
      } else if (e instanceof ApiError && (e.code === 'gone' || e.code === 'not_found')) {
        fail(e);
      } else {
        setErr(errorText(e, sender(o)));
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(o: Opened) {
    setErr(null);
    try {
      await startCode(id, o.keys);
      setCodeSent(true);
    } catch (e) {
      setErr(errorText(e));
    }
  }

  async function confirmCode(o: Opened) {
    setErr(null);
    setBusy(true);
    try {
      const grant = await checkCode(id, o.keys, code.replace(/\s/g, ''));
      await doReveal(o, grant);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.code === 'gone') fail(e);
      else setErr(errorText(e));
    }
  }

  // Email-only links: send the code as soon as the page is shown (D2 says "We just emailed").
  useEffect(() => {
    if (s.k === 'sealed' && s.o.meta.access === 'email' && !codeSent) void sendCode(s.o);
  }, [s.k]);

  const demo = config.value?.demo;
  const page = (body: preact.ComponentChildren) => (
    <Page header={<RecipientHeader />} demoRecipient>
      <main class="main narrow" id="main">{body}</main>
    </Page>
  );

  switch (s.k) {
    case 'loading':
      return page(<section class="sealed" aria-busy="true"><div class="sealed-top tint"><span class="seal-badge"><Mark />{t('reveal.sealed')}</span></div><div class="sealed-body"><p class="from">&nbsp;</p><div class="skeleton h1" /></div></section>);
    case 'broken':
      return page(
        <section class="sealed"><div class="sealed-body">
          <Status kind="danger">Link incomplete</Status>
          <H1>{t('reveal.broken_title')}</H1>
          <p class="lede">{t('reveal.broken_body').replace(' Nothing was revealed or deleted.', '')} <b>Nothing was revealed or deleted.</b></p>
          <div class="input mono broken-url">{s.shown.replace(/#$/, '#')}<span class="missing">…missing</span></div>
          <p class="fine">Copy the whole link again, including everything after <span class="mono">#</span>, or ask the sender to resend it.</p>
        </div></section>,
      );
    case 'missing':
      return <NotFoundBody />;
    case 'gone':
      return page(<Gone reason={s.reason} at={s.at} />);
    case 'error':
      return page(<><Banner kind="danger" icon="alert">{s.message}</Banner><Btn kind="secondary" icon="refresh" onClick={() => location.reload()}>{t('send.try_again')}</Btn></>);
    case 'cleared':
      return page(
        <div class="stack center-col">
          <span class="avatar big ok"><Icon name="check" size="lg" /></span>
          <H1>{t('reveal.cleared')}</H1>
          <a class="btn secondary" href="/">{t('reveal.send_your_own')} <Icon name="arrow" size="sm" /></a>
        </div>,
      );
    case 'open': {
      const left = s.data.views_left;
      return page(
        <Output data={s.data} title={s.o.title ?? ''} from={s.o.from} onCleared={() => setS({ k: 'cleared' })}
          deletedNote={left > 0 ? `${t('reveal.opened_n_banner', { used: s.o.meta.max_views - left, max: s.o.meta.max_views })} This page is your copy.` : t('reveal.deleted_banner')} />,
      );
    }
  }

  const o = s.o;
  const m = o.meta;
  const revealing = s.k === 'revealing';
  const badge = m.access === 'email' || m.access === 'org' ? t('reveal.sealed_one_person') : m.passphrase ? t('reveal.needs_passphrase') : t('reveal.sealed');
  const nf = o.fields ?? 0;
  const contents = nf || m.files ? t('reveal.contents', { fields: nf, files: m.files, both: nf > 0 && m.files > 0 }) : 'A message';
  return page(
    <section class="sealed">
      <div class={`sealed-top tint${revealing ? ' lifting' : ''}`}><span class="seal-badge"><Mark open={revealing} />{badge}</span></div>
      <div class="sealed-body">
        <p class="from"><b>{sender(o)}</b>{config.value?.brand.name ? ` at ${brand}` : ''} sent you</p>
        <H1>{o.title || 'A secret'}</H1>
        <ul class="list">
          <li><Icon name="key" /><span><b>{contents.charAt(0).toUpperCase() + contents.slice(1)}</b> ({bytes(m.size)})</span></li>
          <li><Icon name="eye" />{m.views_left === 1 ? <span><b>Opens once.</b> It’s deleted from the server when you reveal it.</span> : <span>{t('reveal.opens_n', { n: m.views_left })}</span>}</li>
          <li><Icon name="clock" /><span>{t('reveal.available_until', { date: dateTime(m.expires_at) })}</span></li>
        </ul>
        {m.access === 'email' && (
          <>
            <Banner kind="info" icon="mail"><span>Only <b>{m.email_hint}</b> can open this. {codeSent ? 'We just emailed a 6-digit code there.' : 'We’ll email a 6-digit code there.'}</span></Banner>
            <div>
              <label class="label" for="code">{t('reveal.code')}</label>
              <input id="code" class={`input code${err ? ' err' : ''}`} inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} data-autofocus
                aria-describedby="code-help" aria-invalid={!!err} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/[^0-9 ]/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && code.replace(/\s/g, '').length === 6 && void confirmCode(o)} />
              <p class="help" id="code-help">{t('reveal.code_help')} <button class="link" type="button" onClick={() => { void sendCode(o); toast('New code sent'); }}>{t('reveal.code_resend')}</button></p>
            </div>
          </>
        )}
        {m.access === 'org' && !config.value?.signed_in && (
          <Banner kind="info" icon="users"><span>Only people at <b>{m.org_name || brand}</b> can open this. You’ll sign in with {config.value?.features.sso_name || 'single sign-on'} first.</span></Banner>
        )}
        {m.passphrase && (
          <div>
            <label class="label" for="pass">{t('reveal.passphrase_label')}</label>
            <div class={`input mono${err && m.access !== 'email' ? ' err' : ''}`}>
              <input id="pass" class="bare" type={passShown ? 'text' : 'password'} value={pass} autoComplete="off" spellcheck={false} data-autofocus={m.access !== 'email' || undefined}
                aria-invalid={!!err} onInput={(e) => setPass((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && pass && void doReveal(o)} />
              <button type="button" class="btn icon sm ghost" aria-label={passShown ? t('reveal.hide') : t('reveal.show')} onClick={() => setPassShown(!passShown)}><Icon name={passShown ? 'eyeoff' : 'eye'} size="sm" /></button>
            </div>
            {!err && <p class="fine" style="margin-top:8px">{t('reveal.passphrase_hint', { sender: sender(o) })}</p>}
          </div>
        )}
        {err && <ErrMsg>{err}</ErrMsg>}
        <div class="actions-m">
          {m.access === 'email' ? (
            <Btn kind="primary" class="lg full" loading={busy || revealing} disabled={code.replace(/\s/g, '').length !== 6 || (m.passphrase && !pass)} onClick={() => confirmCode(o)}>{t('reveal.confirm_reveal')}</Btn>
          ) : (
            <Btn kind="primary" class="lg full" icon="eye" loading={busy || revealing} disabled={m.passphrase && !pass} onClick={() => doReveal(o)}>
              {revealing ? `Decrypting${s.pct ? ` ${s.pct}%` : '…'}` : err && m.passphrase ? 'Try again' : t('reveal.reveal')}
            </Btn>
          )}
        </div>
        <p class="fine">{t('reveal.nothing_opened', { brand: config.value?.brand.name || 'this sender' }).replace(/Make sure the address is .*$/, '')}Make sure the address is <span class="mono">{host()}</span>.</p>
        {demo && <p class="fine"><button type="button" class="link small" onClick={async () => {
          if (!confirm('Report this link as abuse? It will be deleted for everyone.')) return;
          await report(id, o.keys).catch(() => undefined);
          setS({ k: 'gone', reason: 'destroyed' });
        }}>Report abuse</button></p>}
      </div>
    </section>,
  );
}

function Gone({ reason, at }: { reason: string; at?: string }) {
  const when = at ? dateTime(at) : '';
  const [title, body, tone] = reason === 'expired' ? [`This secret expired${when ? ` on ${when}` : ''}`, 'It was never opened, and it’s been deleted. Ask the sender to send it again.', 'expired']
    : reason === 'destroyed' ? ['The sender destroyed this secret', t('reveal.gone_destroyed_body'), 'expired']
      : reason === 'too_many_tries' ? ['This secret was destroyed', 'Someone entered the wrong passphrase too many times, so it was deleted before it could be read.', 'danger']
        : [`This secret was opened${when ? ` on ${when}` : ''}`, t('reveal.gone_opened_body'), 'warn'];
  return (
    <section class="sealed"><div class="sealed-body">
      <Status kind={tone === 'warn' ? 'warn' : tone === 'danger' ? 'danger' : 'expired'}>{reason === 'opened' ? 'Already opened' : reason === 'expired' ? 'Expired' : 'Destroyed'}</Status>
      <H1>{title}</H1>
      <p class="lede">{body}</p>
      {reason === 'opened' && <Banner kind="warn" icon="alert">Tell the sender so they can change the password and send a new link.</Banner>}
    </div></section>
  );
}

export function NotFoundBody() {
  const brand = config.value?.brand.name;
  return (
    <Page header={<RecipientHeader />}>
      <main class="main narrow" id="main" style="padding-top:96px">
        <span class="avatar big" aria-hidden="true"><Icon name="search" size="lg" /></span>
        <H1>{t('errors.not_found')}</H1>
        <p class="lede">If someone sent you a link, it may be incomplete. Copy the whole link again, including everything after <span class="mono">#</span>.</p>
        <div class="row"><a class="btn secondary" href="/">Go to {brand ? `${brand} ${t('app.brand_suffix')}` : 'Cryptex'}</a></div>
      </main>
    </Page>
  );
}
