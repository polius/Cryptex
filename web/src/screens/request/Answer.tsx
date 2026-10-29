/** /a/:id#key: someone asked for a secret. Whoever has the link sends it once, no account needed; it's encrypted on
 *  this device for the person who asked (flows/request.ts). The key never leaves this page. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { parseLinkFragment } from '../../crypto/format';
import { cancelUpload } from '../../flows/send';
import { loadRequest, requestCode, sendAnswer, type Asked } from '../../flows/request';
import { dateTime } from '../../lib/format';
import { rich, t } from '../../lib/i18n';
import { dropFragment } from '../../lib/router';
import { cfg, toast } from '../../lib/state';
import { Banner, Btn, copyText, H1, Outcome, Status } from '../../ui/bits';
import { host, Page, RecipientHeader } from '../../ui/chrome';
import { Icon } from '../../ui/icons';
import { errorText } from '../errors';
import { NotFoundBody } from '../reveal/Reveal';
import { charCount, Composer, emptyComposer, isEmpty, type ComposerState } from '../send/Composer';
import { Check, PassphraseBox } from '../send/Policy';
import { Sealing, type SealProgress } from '../send/Sealing';

type State =
  | { k: 'loading' }
  | { k: 'broken' }
  | { k: 'missing' }
  | { k: 'gone'; reason: string }
  | { k: 'error'; message: string }
  | { k: 'ready'; a: Asked }
  | { k: 'sent'; a: Asked; passphrase: string | null };

export function Answer({ id }: { id: string }) {
  const c = cfg();
  const [s, setS] = useState<State>({ k: 'loading' });
  const [composer, setComposer] = useState<ComposerState>(emptyComposer);
  const [sending, setSending] = useState<{ progress: SealProgress; offline: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [pass, setPass] = useState({ on: false, value: '' });
  const paste = useRef<(raw: string) => void>(() => undefined);
  const abort = useRef<AbortController | null>(null);
  const upload = useRef<{ id: string; token: string } | null>(null);

  useEffect(() => {
    const R = parseLinkFragment(location.hash.slice(1));
    if (!R) return setS({ k: 'broken' });
    loadRequest(id, R).then((a) => setS({ k: 'ready', a }), (e) => {
      if (e instanceof ApiError && e.code === 'gone') setS({ k: 'gone', reason: e.reason ?? 'answered' });
      else if (e instanceof ApiError && e.code === 'not_found') setS({ k: 'missing' });
      else if ((e as Error)?.message === 'broken') setS({ k: 'broken' });
      else setS({ k: 'error', message: errorText(e) });
    });
  }, [id]);

  async function send(a: Asked) {
    setErr(null);
    if (isEmpty(composer)) {
      document.getElementById('composer')?.focus();
      return;
    }
    if (pass.on && !pass.value) {
      setErr(t('policy.passphrase_empty'));
      return;
    }
    if (charCount(composer) > c.limits.max_message_chars) {
      setErr(t('errors.limit_exceeded', { limit: t('send.limit_chars', { n: c.limits.max_message_chars }) }));
      return;
    }
    const items = [
      ...(composer.note.trim() ? [{ t: 'note' as const, v: composer.note }] : []),
      ...composer.fields.filter((f) => f.k.trim() || f.v).map((f) => ({ t: 'field' as const, k: f.k.trim() || t('send.field_value'), v: f.v, secret: f.secret })),
    ];
    const ctrl = new AbortController();
    abort.current = ctrl;
    setSending({ progress: { stream: 0, done: 0, total: 1 }, offline: false });
    try {
      const passphrase = pass.on ? pass.value : null;
      await sendAnswer(c, a, { title: composer.title, items, files: composer.files }, passphrase,
        (progress) => setSending({ progress, offline: !navigator.onLine }), ctrl.signal, (sid, token) => {
          upload.current = { id: sid, token };
        });
      upload.current = null;
      dropFragment(); // its one answer is sent: the link has nothing more to do here
      setComposer(emptyComposer());
      setPass({ on: false, value: '' });
      setS({ k: 'sent', a, passphrase });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (e instanceof ApiError && e.code === 'gone') setS({ k: 'gone', reason: e.reason ?? 'answered' });
      else {
        setErr(errorText(e));
        requestAnimationFrame(() => document.getElementById('answer-go')?.focus({ preventScroll: true }));
      }
    } finally {
      setSending(null);
    }
  }

  async function cancel() {
    setCancelling(true);
    abort.current?.abort();
    if (upload.current) await cancelUpload(upload.current.id, upload.current.token);
    upload.current = null;
    setCancelling(false);
    setSending(null);
  }

  const page = (body: preact.ComponentChildren, wide = false) => (
    <Page header={<RecipientHeader />}><main class={`main ${wide ? 'send-page' : 'narrow'}`} id="main">{body}</main></Page>
  );

  switch (s.k) {
    case 'loading':
      return page(<div class="send-head" aria-busy="true"><div class="skeleton h1" /></div>, true);
    case 'missing':
      return <NotFoundBody />;
    case 'broken':
      return page(
        <section class="sealed"><div class="sealed-body">
          <Status kind="danger">{t('reveal.broken_badge')}</Status>
          <H1>{t('reveal.broken_title')}</H1>
          <p class="lede">{rich('reveal.broken_fix_anon', { hash: <span class="mono">#</span> })}</p>
        </div></section>,
      );
    case 'gone': {
      const r = s.reason === 'expired' || s.reason === 'closed' ? s.reason : 'answered';
      return page(<Outcome icon={r === 'answered' ? 'check' : 'clock'} tone="info" title={t(`answer.${r}_title`)}><p>{t(`answer.${r}_body`)}</p></Outcome>);
    }
    case 'error':
      return page(<><H1 class="sr">{t('ask.title')}</H1><Banner kind="danger" icon="alert">{s.message}</Banner>
        <Btn kind="secondary" icon="refresh" onClick={() => location.reload()}>{t('send.try_again')}</Btn></>);
    case 'sent':
      return page(
        <Outcome icon="check" title={t('answer.sent_title')}>
          <p>{t('answer.sent_body')}</p>
          {s.passphrase && (
            <div class="stack answer-pass">
              <div class="linkbox pass-ready">
                <span class="pass-k"><Icon name="key" size="sm" />{t('policy.passphrase')}</span>
                <span class="url mono">{s.passphrase}</span>
                <Btn kind="secondary" icon="copy" onClick={() => copyText(s.passphrase!)}>{t('reveal.copy')}</Btn>
              </div>
              <p class="muted small">{t('answer.passphrase_tell')}</p>
            </div>
          )}
        </Outcome>,
      );
  }

  const a = s.a;
  const busy = !!sending;
  return page(<>
    <div class={`send-head${a.note ? ' has-note' : ''}`}>
      <H1>{t('answer.title')}</H1>
      <p class="lede">{t('answer.lede')}</p>
      {a.note && (
        <figure class="ask-said">
          <figcaption><Icon name="user" size="sm" />{t('answer.note')}</figcaption>
          <blockquote>{a.note}</blockquote>
        </figure>
      )}
    </div>
    <Composer state={composer} onChange={setComposer} maxChars={c.limits.max_message_chars} maxFiles={c.limits.max_files}
      maxFileBytes={c.limits.max_file_bytes} disabled={busy} onFilesRejected={(m) => toast(m, 'error')} registerPaste={(fn) => { paste.current = fn; }}
      trailing={!busy && (
        <span class="cmp-go">
          <Btn kind="primary" id="answer-go" icon="lock" onClick={() => void send(a)} unavailable={isEmpty(composer)}
            title={isEmpty(composer) ? t('send.empty_error') : undefined}>{err ? t('send.try_again') : t('answer.send')}</Btn>
        </span>
      )} />
    {!busy && (
      <div class="answer-opts">
        <Check on={pass.on} onChange={(on) => setPass((p) => ({ ...p, on }))} title={t('policy.passphrase_ask')} help={t('policy.passphrase_help')} />
        {pass.on && <PassphraseBox value={pass.value} onChange={(value) => setPass((p) => ({ ...p, value }))} />}
      </div>
    )}
    {err && <p class="err-msg" role="alert"><Icon name="alert" size="sm" />{err}</p>}
    {sending && (composer.files.length ? (
      <Sealing files={composer.files} manifestBytes={Math.max(1, sending.progress.total - composer.files.reduce((n, f) => n + f.size, 0))}
        progress={sending.progress} offline={sending.offline} onCancel={() => void cancel()} cancelling={cancelling} />
    ) : <p class="fine" role="status">{t('answer.sending')}</p>)}
    <ul class="list ask-facts">
      <li><Icon name="lock" /><span>{t('answer.private', { host: host() })}</span></li>
      <li><Icon name="clock" /><span>{t('answer.until', { date: dateTime(a.expires_at) })}</span></li>
      <li><Icon name="inbox" /><span>{t('ask.code')} <b class="mono">{requestCode(a.id)}</b></span></li>
    </ul>
  </>, true);
}
