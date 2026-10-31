/** /s/:id#key (D1–D7). Loading changes nothing; Reveal is a click. The key never leaves this page. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { parseLinkFragment } from '../../crypto/format';
import { askedHere, carryOver, finishReveal, loadMeta, openedHere, readingGone, report, startReveal, type Opened, type Reading, type Revealed } from '../../flows/reveal';
import { bytes, dateTime, MAX_PASSPHRASE } from '../../lib/format';
import { rich, t } from '../../lib/i18n';
import { dropFragment } from '../../lib/router';
import { config, toast } from '../../lib/state';
import { Banner, Btn, ErrMsg, H1, masked, Outcome, Status, useViewFocus } from '../../ui/bits';
import { AppHeader, host, Page, RecipientHeader } from '../../ui/chrome';
import { Icon, Mark } from '../../ui/icons';
import { errorText } from '../errors';
import { Output } from './Output';
import { confirmDialog } from '../../ui/confirm';

type State =
  | { k: 'loading' }
  | { k: 'broken'; shown: string }
  | { k: 'missing' }
  | { k: 'gone'; reason: string; at?: string; opened?: boolean }
  | { k: 'sealed'; o: Opened }
  | { k: 'revealing'; o: Opened; pct: number }
  /** Revealed, but the download stopped: Try again continues it with the same read session. */
  | { k: 'stopped'; o: Opened }
  /** Revealed, the download stopped, and the read session is gone: nothing more can be fetched. */
  | { k: 'unfinished'; o: Opened }
  /** This tab revealed it earlier (a reload after the key left the address bar, or the link opened again).
   *  `dropped`: this tab asked to reveal it, the answer never arrived, and now it's used up: most likely by that. */
  | { k: 'here'; at: string; gone: boolean; dropped?: boolean }
  | { k: 'open'; o: Opened; data: Revealed }
  | { k: 'cleared'; left: number | null }
  | { k: 'error'; message: string };

/** Key read once on load, kept in memory only. */
let initialFragment: string | null = null;

export function Reveal({ id }: { id: string }) {
  const [s, setS] = useState<State>({ k: 'loading' });
  const [pass, setPass] = useState('');
  const [passShown, setPassShown] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);
  const K = useRef<Uint8Array | null>(null);
  const inFlight = useRef(false); // Enter twice, or Enter and a click, must not ask the server twice
  const reading = useRef<Reading | null>(null); // after POST /reveal, until everything is shown
  // The page changes in place: its heading takes focus once it has loaded, and again when a state replaces another
  // (the stopped download, an error, cleared), since the button that was pressed is gone. Revealing is still the
  // sealed page, its button busy; the revealed secret takes focus itself (doReveal).
  useViewFocus(s.k === 'loading' ? null : s.k === 'revealing' ? 'sealed' : s.k);

  useEffect(() => {
    const frag = initialFragment ?? location.hash.slice(1);
    initialFragment = frag;
    const key = parseLinkFragment(frag);
    if (!key) {
      const at = openedHere(id);
      setS(at ? { k: 'here', at, gone: false } : { k: 'broken', shown: `${host()}/s/${id}#${frag}` });
      return;
    }
    K.current = key;
    loadMeta(id, key).then((o) => setS({ k: 'sealed', o }), (e) => fail(e));
    return () => {
      initialFragment = null;
    };
  }, [id]);

  function fail(e: unknown) {
    const here = openedHere(id);
    const asked = askedHere(id);
    if (e instanceof ApiError && e.code === 'gone' && (e.reason ?? 'opened') === 'opened' && here) setS({ k: 'here', at: here, gone: true });
    else if (e instanceof ApiError && e.code === 'gone' && (e.reason ?? 'opened') === 'opened' && asked) setS({ k: 'here', at: asked, gone: true, dropped: true });
    else if (e instanceof ApiError && e.code === 'gone') setS({ k: 'gone', reason: e.reason ?? 'opened', at: e.at, opened: e.opened });
    else if (e instanceof ApiError && e.code === 'not_found') setS({ k: 'missing' });
    else setS({ k: 'error', message: errorText(e, t('reveal.the_sender')) });
  }

  // Mid-sentence: the sender's username (shown only to someone signed in here), else "the sender".
  const sender = (o: Opened) => o.from || t('reveal.the_sender');
  const brand = config.value?.brand.name || host();

  /** Reveal, or continue a download that stopped (Try again on the "stopped" page) with the same read session. */
  async function doReveal(o: Opened) {
    if (inFlight.current) return;
    inFlight.current = true;
    setErr(null);
    setBusy(true);
    const progress = (done: number, total: number) => setS({ k: 'revealing', o, pct: Math.round((100 * done) / total) });
    try {
      setS({ k: 'revealing', o, pct: reading.current ? Math.round((100 * reading.current.done) / reading.current.total) : 0 });
      if (!reading.current) {
        try {
          reading.current = await startReveal(id, K.current!, o, { passphrase: pass });
        } catch (e) {
          if ((e as Error)?.message === 'tampered') reading.current = null; // a bad stream list: the view was counted
          else return notRevealed(o, e);
          throw e;
        }
      }
      const data = await download(o, progress);
      reading.current = null;
      dropFragment(); // the key leaves the address bar only now, so a refresh before reveal still works
      setS({ k: 'open', o, data });
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.out')?.focus()); // the secret itself (tabindex -1)
    } catch (e) {
      stopped(o, e);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** Finish the download. A link that opens more than once, whose read session lapsed, is revealed again (another
   *  view, nothing lost); a one-time link can't be, so its gone read session ends the download. */
  async function download(o: Opened, progress: (done: number, total: number) => void): Promise<Revealed> {
    const r = reading.current!;
    try {
      return await finishReveal(r, progress);
    } catch (e) {
      if (!readingGone(e) || r.views_left === 0) throw e;
      reading.current = carryOver(r, await startReveal(id, K.current!, o, { passphrase: pass }));
      return finishReveal(reading.current, progress);
    }
  }

  /** The server said no before counting a view: nothing was opened, and the page stays as it was. */
  function notRevealed(o: Opened, e: unknown) {
    setS({ k: 'sealed', o });
    if (e instanceof ApiError && e.code === 'wrong_passphrase') {
      setErr(t('errors.wrong_passphrase', { tries: e.triesLeft ?? 0, sender: sender(o) }));
      o.meta.tries_left = e.triesLeft;
    } else if (e instanceof ApiError && (e.code === 'gone' || e.code === 'not_found')) {
      fail(e);
    } else {
      setErr(errorText(e, sender(o)));
    }
  }

  /** A failure after the view was counted. Never "nothing was opened": it was. */
  function stopped(o: Opened, e: unknown) {
    if ((e as Error)?.message === 'tampered') {
      reading.current = null;
      setS({ k: 'error', message: errorText(e, sender(o)) });
    } else if (e instanceof ApiError && e.code === 'gone' && reading.current?.views_left !== 0) {
      reading.current = null; // revealing it again found it expired or destroyed meanwhile
      fail(e);
    } else if (readingGone(e)) {
      reading.current = null;
      setS({ k: 'unfinished', o });
    } else {
      setS({ k: 'stopped', o });
    }
  }

  /** Demo only. Success shows the outcome the next visitor sees too; a failure leaves the link, and this page, as they were. */
  async function doReport(o: Opened) {
    if (!(await confirmDialog({ title: t('reveal.report_title'), body: t('reveal.report_body'), confirm: t('reveal.report_confirm'), danger: true }))) return;
    setReporting(true);
    try {
      setS({ k: 'gone', reason: await report(id, o.keys), opened: false });
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'gone' || e.code === 'not_found')) fail(e);
      else toast(errorText(e), 'error');
    } finally {
      setReporting(false);
    }
  }

  const demo = config.value?.demo;
  const page = (body: preact.ComponentChildren) => (
    <Page header={<RecipientHeader />}>
      <main class="main narrow" id="main">{body}</main>
    </Page>
  );

  switch (s.k) {
    case 'loading':
      return page(<section class="sealed" aria-busy="true"><div class="sealed-top tint"><span class="seal-badge"><Mark />{t('reveal.sealed')}</span></div><div class="sealed-body"><p class="from">&nbsp;</p><div class="skeleton h1" /></div></section>);
    case 'broken':
      return page(
        <section class="sealed"><div class="sealed-body">
          <Status kind="danger">{t('reveal.broken_badge')}</Status>
          <H1>{t('reveal.broken_title')}</H1>
          <p class="lede">{rich('reveal.broken_body_rich', { safe: <b>{t('reveal.broken_safe')}</b> })}</p>
          <div class="input mono broken-url">{s.shown.replace(/#$/, '#')}<span class="missing">{t('reveal.broken_missing')}</span></div>
          <p class="fine">{rich('reveal.broken_fix_anon', { hash: <span class="mono">#</span> })}</p>
        </div></section>,
      );
    case 'missing':
      return <NotFoundBody />;
    case 'here':
      return page(
        <section class="sealed"><div class="sealed-body">
          <Status kind="warn">{t('reveal.badge_opened')}</Status>
          <H1>{t(s.dropped ? 'reveal.dropped_title' : 'reveal.opened_here_title')}</H1>
          <p class="lede">{t(s.dropped ? 'reveal.dropped_body' : s.gone ? 'reveal.opened_here_gone_body' : 'reveal.opened_here_body', { date: dateTime(s.at) })}</p>
          <div class="row"><a class="btn secondary" href="/">{t('reveal.go_to', { name: config.value?.brand.name || 'Cryptex' })}</a></div>
        </div></section>,
      );
    case 'stopped':
      return page(
        <section class="sealed"><div class="sealed-body">
          <Status kind="warn">{t('reveal.stopped_badge')}</Status>
          <H1>{t('reveal.stopped_title')}</H1>
          <p class="lede">{t('reveal.stopped_body')}</p>
          <div class="actions-m"><Btn kind="primary" class="lg full" icon="refresh" onClick={() => void doReveal(s.o)}>{t('send.try_again')}</Btn></div>
        </div></section>,
      );
    case 'unfinished':
      return page(
        <section class="sealed"><div class="sealed-body">
          <Status kind="danger">{t('reveal.stopped_badge')}</Status>
          <H1>{t('reveal.unfinished_title')}</H1>
          <p class="lede">{t('reveal.unfinished_body', { sender: s.o.from || t('reveal.the_sender') })}</p>
          <div class="row"><a class="btn secondary" href="/">{t('reveal.go_to', { name: config.value?.brand.name || 'Cryptex' })}</a></div>
        </div></section>,
      );
    case 'gone':
      return page(<Gone reason={s.reason} at={s.at} opened={s.opened} />);
    case 'error':
      return page(<><H1 class="sr">{t('reveal.a_secret')}</H1><Banner kind="danger" icon="alert">{s.message}</Banner><Btn kind="secondary" icon="refresh" onClick={() => location.reload()}>{t('send.try_again')}</Btn></>);
    case 'cleared':
      return page(
        <Outcome icon="check" title={t('reveal.cleared_title')}
          actions={<a class="btn secondary" href="/"><Icon name="send" size="sm" />{t('reveal.send_your_own')}</a>}>
          <p>{s.left === 0 ? t('reveal.cleared_deleted') : t('reveal.cleared_still_works')}</p>
          <p class="fine">{t('reveal.cleared_clipboard')}</p>
        </Outcome>,
      );
    case 'open': {
      const left = s.data.views_left;
      return page(
        <Output data={s.data} title={s.o.title ?? ''} from={s.o.from} onCleared={() => {
          // The link key goes with what it opened: nothing on this page can decrypt it again.
          K.current = null;
          initialFragment = null;
          reading.current = null;
          setS({ k: 'cleared', left });
        }}
          deletedNote={left === 0 ? t('reveal.deleted_banner') : t('reveal.still_works_copy')} />,
      );
    }
  }

  const o = s.o;
  const m = o.meta;
  const revealing = s.k === 'revealing';
  const badge = m.passphrase ? t('reveal.needs_passphrase') : t('reveal.sealed');
  const nf = o.fields ?? 0;
  const contents = nf || m.files ? t('reveal.contents', { fields: nf, files: m.files, both: nf > 0 && m.files > 0 }) : t('reveal.a_message');
  return page(
    <section class="sealed">
      <div class={`sealed-top tint${revealing ? ' lifting' : ''}`}><span class="seal-badge"><Mark open={revealing} />{badge}</span></div>
      <div class="sealed-body">
        <p class="from">{o.from ? rich(config.value?.brand.name ? 'reveal.from' : 'reveal.from_no_brand', { sender: <b>{o.from}</b>, brand })
          : config.value?.brand.name ? rich('reveal.from_brand', { brand: <b>{brand}</b> }) : t('reveal.from_no_brand', { sender: t('reveal.someone') })}</p>
        <H1>{o.title || t('reveal.a_secret')}</H1>
        <ul class="list">
          <li><Icon name="key" /><span>{m.files ? rich('reveal.contents_size', { contents: <b>{contents.charAt(0).toUpperCase() + contents.slice(1)}</b>, size: bytes(m.size) }) : <b>{contents.charAt(0).toUpperCase() + contents.slice(1)}</b>}</span></li>
          <li><Icon name="eye" />{m.views_left === 1 ? <span>{rich('reveal.opens_once_rich', { lead: <b>{t('reveal.opens_once_lead')}</b> })}</span> : <span>{t('reveal.opens_until_expiry')}</span>}</li>
          <li><Icon name="clock" /><span>{t('reveal.available_until', { date: dateTime(m.expires_at) })}</span></li>
        </ul>
        {m.passphrase && (
          <div>
            <label class="label" for="pass">{t('reveal.passphrase_label')}</label>
            <div class={`input mono${err ? ' err' : ''}`}>
              <input id="pass" class="bare" {...masked(!passShown)} value={pass} maxLength={MAX_PASSPHRASE} autoComplete="off" spellcheck={false} data-autofocus
                readOnly={busy || revealing} aria-invalid={!!err} aria-describedby={err ? 'pass-err' : 'pass-hint'}
                onInput={(e) => setPass((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && pass && void doReveal(o)} />
              <button type="button" class="btn icon sm ghost" aria-label={passShown ? t('reveal.hide') : t('reveal.show')} onClick={() => setPassShown(!passShown)}><Icon name={passShown ? 'eyeoff' : 'eye'} size="sm" /></button>
            </div>
            {!err && <p class="fine" id="pass-hint" style="margin-top:8px">{o.from ? t('reveal.passphrase_hint', { sender: o.from }) : t('reveal.passphrase_hint_anon')}</p>}
          </div>
        )}
        {err && <ErrMsg id="pass-err">{err}</ErrMsg>}
        <div class="actions-m">
          <Btn kind="primary" class="lg full" icon="eye" loading={busy || revealing} disabled={m.passphrase && !pass} onClick={() => doReveal(o)}>
            {revealing ? (s.pct ? t('reveal.decrypting_pct', { pct: s.pct }) : t('reveal.decrypting')) : err && m.passphrase ? t('send.try_again') : t('reveal.reveal')}
          </Btn>
        </div>
        <p class="fine">{rich(config.value?.brand.name ? 'reveal.nothing_opened' : 'reveal.nothing_opened_no_brand', { brand: config.value?.brand.name, host: <span class="mono">{host()}</span> })}</p>
        {demo && <p class="fine"><button type="button" class="link small" disabled={reporting || revealing} onClick={() => void doReport(o)}>{t('reveal.report')}</button></p>}
      </div>
    </section>,
  );
}

/** What happened to it, from the server's reason and whether it was ever revealed: an expired or destroyed link
 *  that was opened before never says "never opened". */
function Gone({ reason, at, opened }: { reason: string; at?: string; opened?: boolean }) {
  const when = at ? dateTime(at) : '';
  const brand = config.value?.brand.name;
  const [title, body, tone] = reason === 'expired'
    ? [when ? t('reveal.gone_expired_title', { date: when }) : t('reveal.gone_expired_title_undated'), opened ? t('reveal.gone_expired_body_opened') : t('reveal.gone_expired_body_anon'), 'expired']
    : reason === 'destroyed' ? [t('reveal.gone_destroyed_title_anon'), opened ? t('reveal.gone_destroyed_body_opened') : t('reveal.gone_destroyed_body'), 'expired']
      : reason === 'reported' ? [t('reveal.gone_reported_title'), t('reveal.gone_reported_body'), 'danger']
        : reason === 'too_many_tries' ? [t('reveal.gone_tries_title'), opened ? t('reveal.gone_tries_body_opened') : t('reveal.gone_tries_body'), 'danger']
          : [when ? t('reveal.gone_opened_title', { date: when }) : t('reveal.gone_opened_title_undated'), t('reveal.gone_opened_body'), 'warn'];
  return (
    <section class="sealed"><div class="sealed-body">
      <Status kind={tone === 'warn' ? 'warn' : tone === 'danger' ? 'danger' : 'expired'}>{reason === 'opened' ? t('reveal.badge_opened') : reason === 'expired' ? t('reveal.badge_expired') : t('status.destroyed')}</Status>
      <H1>{title}</H1>
      <p class="lede">{body}</p>
      {reason === 'opened' && <Banner kind="warn" icon="alert">{t('reveal.gone_tell_anon')}</Banner>}
      <div class="row"><a class="btn secondary" href="/">{t('reveal.go_to', { name: brand || 'Cryptex' })}</a></div>
    </div></section>
  );
}

/** Nothing at this address: the same card as a link that's gone. A link's address (/s/, /a/) keeps the recipient's
 *  header; anywhere else, someone signed in (or in the demo) keeps the app's. */
export function NotFoundBody() {
  const c = config.value;
  const app = !/^\/[sa]\//.test(location.pathname) && !!(c?.signed_in || c?.demo);
  return (
    <Page header={app ? <AppHeader /> : <RecipientHeader />}>
      <main class="main narrow" id="main">
        <section class="sealed"><div class="sealed-body">
          <Status kind="expired">{t('reveal.badge_not_found')}</Status>
          <H1>{t('errors.not_found')}</H1>
          <p class="lede">{rich('reveal.not_found_body', { hash: <span class="mono">#</span> })}</p>
          <div class="row"><a class="btn secondary" href="/">{t('reveal.go_to', { name: c?.brand.name || 'Cryptex' })}</a></div>
        </div></section>
      </main>
    </Page>
  );
}
