/** "/" (A1–A8, G1): send a secret. After create, the URL stays "/". */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, signedInUid } from '../api/client';
import { cancelUpload, destroySecret, sendSecret, type Sent } from '../flows/send';
import { dateTime, relative } from '../lib/format';
import { t } from '../lib/i18n';
import { navigate, route } from '../lib/router';
import { cfg, countLinks, loadConfig, toast } from '../lib/state';
import { ExpandedComposer } from './send/Expanded';
import { prefs, receipts } from '../store/db';
import { Banner, Btn, H1 } from '../ui/bits';
import { AppHeader, host, Page } from '../ui/chrome';
import { Icon, Mark } from '../ui/icons';
import { AskButton } from './request/AskButton';
import { charCount, Composer, DropZone, emptyComposer, isEmpty, usePageInput, type ComposerState } from './send/Composer';
import { LinkReady } from './send/LinkReady';
import { clampPolicy, defaultPolicy, opensLabel, OptionsPanel, SendFoot, sendRuleItems, type SendPolicy } from './send/Policy';
import { Sealing, type SealProgress } from './send/Sealing';
import { errorText } from './errors';

type Phase =
  | { k: 'compose' }
  /** step: 1 locking on this device, 2 saving, 3 link ready, 4 leaving for the link page. slow: show the detailed progress card. */
  | { k: 'sealing'; progress: SealProgress; offline: boolean; step: 1 | 2 | 3 | 4; slow: boolean }
  | { k: 'error'; message: string }
  | { k: 'sent'; sent: Sent; copied: boolean; passphrase: string | null };


/** Short sends finish in a blink (about 0.3 s, demo proof of work included), so the seal sets the pace: one continuous
 *  motion of about 1.3 s to the link page, long enough to read, short enough to repeat all day. Longer uploads take as
 *  long as they take; the detailed progress card joins in after SLOW_MS. live.css times its keyframes to these. */
const SEAL = { lock: 600, save: 300, ready: 380, leave: 180 };
const SLOW_MS = 3000;
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, calm() ? 0 : Math.max(0, ms)));

export function Home() {
  const c = cfg();
  const [composer, setComposer] = useState<ComposerState>(emptyComposer);
  const [policy, setPolicy] = useState<SendPolicy>(() => defaultPolicy(c));
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: 'compose' });
  const [formError, setFormError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const upload = useRef<{ id: string; token: string } | null>(null);
  const pasteHandler = useRef<(raw: string) => void>(() => undefined);
  const dropHandler = useRef<(files: File[]) => void>(() => undefined);
  const dragging = usePageInput(phase.k === 'compose', pasteHandler, dropHandler);

  // Restore the last-used policy, within today's limits.
  useEffect(() => {
    if (c.demo) return;
    prefs.get<SendPolicy>('policy').then((p) => p && setPolicy(clampPolicy({ ...defaultPolicy(c), ...p }, c))).catch(() => undefined);
  }, []);

  // ⌘/Ctrl+Enter creates (⌘/Ctrl+V anywhere pastes into the composer, and files drop anywhere: usePageInput).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && phase.k === 'compose') {
        e.preventDefault();
        setExpanded(false);
        void create();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const tryCopy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      return true;
    } catch {
      return false;
    }
  };

  // ------------------------------------------------------------------ send
  async function create() {
    setFormError(null);
    if (isEmpty(composer)) {
      // Nothing to send yet: the button is shown as unavailable, so a click (or ⌘Enter) just puts the cursor where to type.
      document.getElementById('composer')?.focus();
      return;
    }
    if (charCount(composer) > c.limits.max_message_chars) {
      setFormError(t('errors.limit_exceeded', { limit: t('send.limit_chars', { n: c.limits.max_message_chars }) }));
      return;
    }
    if (policy.passphraseOn && !policy.passphrase) {
      setOptionsOpen(true);
      setFormError(t('policy.passphrase_empty'));
      return;
    }
    const items = [
      ...(composer.note.trim() ? [{ t: 'note' as const, v: composer.note }] : []),
      ...composer.fields.filter((f) => f.k.trim() || f.v).map((f) => ({ t: 'field' as const, k: f.k.trim() || t('send.field_value'), v: f.v, secret: f.secret })),
    ];
    const ctrl = new AbortController();
    abort.current = ctrl;
    setOptionsOpen(false);
    const started = Date.now();
    const sealing = (x: Partial<Extract<Phase, { k: 'sealing' }>>) => setPhase((p) => (p.k === 'sealing' ? { ...p, ...x } : p));
    setPhase({ k: 'sealing', progress: { stream: 0, done: 0, total: 1 }, offline: false, step: 1, slow: composer.files.length > 0 });
    const timers = [setTimeout(() => sealing({ step: 2 }), calm() ? 0 : SEAL.lock), setTimeout(() => sealing({ slow: true }), SLOW_MS)];
    const onOffline = () => setPhase((p) => (p.k === 'sealing' ? { ...p, offline: true } : p));
    const onOnline = () => setPhase((p) => (p.k === 'sealing' ? { ...p, offline: false } : p));
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    try {
      const sent = await sendSecret(c, { title: composer.title, items, files: composer.files }, {
        views: policy.views, expires_in: policy.expires_in,
        passphrase: policy.passphraseOn ? policy.passphrase : null,
      }, (progress) => sealing({ progress, offline: !navigator.onLine }), ctrl.signal, (id, token) => {
        upload.current = { id, token };
      });
      upload.current = null;
      if (!c.demo) void prefs.set('policy', { ...policy, passphraseOn: false, passphrase: '' });
      const passphrase = policy.passphraseOn ? policy.passphrase : null;
      setPolicy((p) => ({ ...p, passphraseOn: false, passphrase: '' })); // each link gets its own passphrase
      const copied = await tryCopy(sent.link); // right away: browsers only allow it shortly after the click
      clearTimeout(timers[1]);
      await pause(SEAL.lock + SEAL.save - (Date.now() - started));
      sealing({ step: 3 });
      await pause(SEAL.ready);
      sealing({ step: 4 }); // the page fades up and out, then the link page rises in
      await pause(SEAL.leave);
      setPhase({ k: 'sent', sent, copied, passphrase });
      // The address becomes the link's own page (its receipt), so a reload or a bookmark lands there; the page itself
      // stays this one until the person moves on. Back returns to "/", which resets this page (below).
      history.pushState(null, '', `/r/${sent.id}`);
      countLinks();
      if (c.demo) void loadConfig().catch(() => undefined); // refresh the quota in the demo bar
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (e instanceof ApiError && e.code === 'rate_limited' && c.demo && e.reason === 'demo_day') { // today's links are used up
        navigate('/demo/limit');
        return;
      }
      setPhase({ k: 'error', message: e instanceof ApiError && e.code === 'offline' ? t('send.error_offline', { host: host() }) : errorText(e) });
      // The seal and its buttons are gone: focus goes to Try again (the error itself is announced).
      requestAnimationFrame(() => document.getElementById('send-go')?.focus({ preventScroll: true }));
    } finally {
      timers.forEach(clearTimeout);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    }
  }

  async function cancel() {
    setCancelling(true);
    abort.current?.abort();
    if (upload.current) await cancelUpload(upload.current.id, upload.current.token);
    upload.current = null;
    setCancelling(false);
    setPhase({ k: 'compose' });
  }

  const reset = () => {
    if (location.pathname !== '/') history.replaceState(null, '', '/'); // from the link page's /r/<id> (Send another)
    setComposer(emptyComposer());
    setPolicy((p) => ({ ...p, passphraseOn: false, passphrase: '' }));
    setPhase({ k: 'compose' });
    setTimeout(() => document.getElementById('composer')?.focus());
  };

  // The options panel opens and closes from "Change", which keeps its place; closing (Done or Esc) returns focus there.
  const closeOptions = () => {
    setOptionsOpen(false);
    requestAnimationFrame(() => document.getElementById('options-toggle')?.focus());
  };

  // Leaving the link page (Back to "/", the logo or "New secret") changes the route: start a fresh secret from there.
  const nav = route.value;
  const firstNav = useRef(nav);
  useEffect(() => {
    if (nav !== firstNav.current && (phase.k === 'sent' || phase.k === 'error')) reset();
  }, [nav]);

  // ------------------------------------------------------------------ render
  if (phase.k === 'sent') {
    const s = phase.sent;
    const passphrase = phase.passphrase;
    const fields = composer.fields.filter((f) => f.k || f.v).length;
    const contains = t('reveal.contents', { fields, files: composer.files.length, both: fields > 0 && composer.files.length > 0 }) || t('send.contains_message');
    return (
      <Page header={<AppHeader active="new" />}>
        <main class="main send-page arrive" id="main">
          <LinkReady passphrase={passphrase} copied={phase.copied} copiedLabel={t('send.link_copied')} title={composer.title.trim() || t('send.ready_title')} status={t('send.waiting')} link={s.link}
            banner={s.saved !== 'ok' && <Banner kind="warn" icon="alert">{s.saved === 'local' ? t('send.saved_locally') : t('send.not_saved')}</Banner>}
            facts={[
              { k: t('send.fact_opens'), v: opensLabel(policy.views) },
              { k: t('send.fact_expires'), v: dateTime(s.expires_at), sub: relative(s.expires_at) },
              { k: t('send.fact_contains'), v: contains.charAt(0).toUpperCase() + contains.slice(1) },
            ]}
            destroyLabel={t('links.delete')} destroyTitle={t('links.delete_title', { title: composer.title.trim() || t('send.your_secret') })}
            destroyBody={t('links.delete_body_live')}
            onDestroy={async () => {
              // Destroy: the link stops working and leaves Your links (a failure stays in the dialog: LinkReady).
              await destroySecret(s.id, s.manage_token);
              await receipts.remove(s.id).catch(() => undefined);
              if (signedInUid()) await api('DELETE', `/me/receipts/${s.id}`).catch(() => undefined);
              toast(t('links.deleted'));
              reset();
            }}
            actions={<>
              <Btn kind="secondary" icon="plus" onClick={reset}>{t('send.send_another')}</Btn>
              <Btn kind="primary" href={`/r/${s.id}`}>{t('send.done')}</Btn>
            </>} />
        </main>
      </Page>
    );
  }

  const sealing = phase.k === 'sealing';

  return (
    <Page header={<AppHeader active="new" />}>
      <DropZone on={dragging} />
      <main class={`main send-page${phase.k === 'sealing' && phase.step === 4 ? ' leaving' : ''}`} id="main">
        {phase.k === 'error' && (
          <><H1 class="sr">{t('send.title')}</H1><Banner kind="danger" icon="alert">{phase.message} {t('send.retry_note')}</Banner></>
        )}
        {phase.k !== 'error' && (
          <div class="send-head">
            <div class="head-row">
              <H1>{t('send.title')}</H1>
              {phase.k === 'compose' && <div class="page-acts"><AskButton /></div>}
            </div>
            <p class="lede">{policy.views === null ? t('send.lede_until_expiry') : t('send.lede_once')}</p>
          </div>
        )}

        <>
            <Composer state={composer} onChange={setComposer} maxChars={c.limits.max_message_chars} maxFiles={c.limits.max_files}
              maxFileBytes={c.limits.max_file_bytes} disabled={sealing} onFilesRejected={(m) => toast(m, 'error')}
              registerPaste={(fn) => { pasteHandler.current = fn; }} registerDrop={(fn) => { dropHandler.current = fn; }}
              onExpand={() => setExpanded(true)}
              overlay={phase.k === 'sealing' && <SealOverlay step={phase.step} lines={cipherLines(composer)} />}
              trailing={!sealing && (
                <span class="cmp-go">
                  <Btn kind="primary" id="send-go" icon={phase.k === 'error' && !isEmpty(composer) ? 'refresh' : 'link'} onClick={create} unavailable={isEmpty(composer)}
                    title={isEmpty(composer) ? t('send.empty_error') : t('send.create_title')}>
                    {phase.k === 'error' && !isEmpty(composer) ? t('send.try_again') : t('send.create')}</Btn>
                </span>
              )} />
            <ExpandedComposer open={expanded && !sealing} onClose={() => setExpanded(false)} state={composer} onChange={setComposer}
              maxChars={c.limits.max_message_chars} maxFiles={c.limits.max_files} maxFileBytes={c.limits.max_file_bytes}
              onFilesRejected={(m) => toast(m, 'error')} />
            {phase.k === 'sealing' && !phase.slow ? (
              <SendFoot items={sendRuleItems(policy)} />
            ) : phase.k === 'sealing' ? (
              <Sealing files={composer.files} manifestBytes={Math.max(1, phase.progress.total - composer.files.reduce((n, f) => n + f.size, 0))}
                progress={phase.progress} offline={phase.offline} onCancel={cancel} cancelling={cancelling} />
            ) : (
              <>
                {optionsOpen && <OptionsPanel policy={policy} onChange={setPolicy} onDone={closeOptions} cfg={c} />}
                {formError && <p class="err-msg" role="alert"><Icon name="alert" size="sm" />{formError}</p>}
                <SendFoot items={sendRuleItems(policy)} open={optionsOpen} onChange={() => (optionsOpen ? closeOptions() : setOptionsOpen(true))} />
              </>
            )}
        </>
      </main>
    </Page>
  );
}

/** What's in the composer, as plain lines for the scramble (values included: it's this person's own screen). */
function cipherLines(c: ComposerState): string[] {
  return [
    ...(c.title.trim() ? [c.title.trim()] : []),
    ...(c.note ? c.note.split('\n') : []),
    ...c.fields.filter((f) => f.k || f.v).map((f) => `${f.k}  ${f.v}`),
    ...c.files.map((f) => f.name),
  ];
}

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789#%&*+=?@$/';

/** The person's own text turning into gibberish from left to right, then shuffling until the seal is done. */
function Cipher({ lines, ms }: { lines: string[]; ms: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const src = lines.join('\n').slice(0, 600);
    if (!el || calm()) {
      if (el) el.textContent = src.replace(/\S/g, () => GLYPHS[(Math.random() * GLYPHS.length) | 0]);
      return;
    }
    const start = performance.now();
    let last = 0;
    let raf = 0;
    const tick = (now: number) => {
      if (now - last > 45) {
        last = now;
        const cut = ((now - start) / ms) * src.length * 1.1;
        let out = '';
        for (let i = 0; i < src.length; i++) {
          const ch = src[i];
          out += /\s/.test(ch) || i > cut ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0];
        }
        el.textContent = out;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div class="seal-cipher" ref={ref} aria-hidden="true">{lines.join('\n')}</div>;
}

/** The seal closing over the composer while the link is made: the same pattern the recipient sees lift when they reveal. */
function SealOverlay({ step: at, lines }: { step: 1 | 2 | 3 | 4; lines: string[] }) {
  const step = Math.min(at, 3) as 1 | 2 | 3;
  const text = step === 1 ? t('send.seal_locking') : step === 2 ? t('send.seal_saving') : t('send.seal_ready');
  return (
    <div class={`seal-over s${step}`} style={`--lock:${SEAL.lock}ms;--save:${SEAL.save}ms;--ready:${SEAL.ready}ms`}>
      <Cipher lines={lines} ms={SEAL.lock * 0.75} />
      <div class="seal-cover tint" aria-hidden="true" />
      <span class="seal-mark" aria-hidden="true">{step === 3 ? <Icon name="check" /> : <Mark open={step === 1} />}</span>
      <div class="seal-status">
        <span class="seal-txt" key={step} role="status"><Icon name={step === 3 ? 'check' : 'lock'} size="sm" />{text}</span>
        <span class="seal-bar" aria-hidden="true">
          {([1, 2, 3] as const).map((n) => <i key={n} class={n < step ? 'done' : n === step ? 'now' : ''}><b /></i>)}
        </span>
      </div>
    </div>
  );
}
