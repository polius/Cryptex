/** "/" (A1–A8, C1–C2, G1): Send or Request. After create, the URL stays "/". */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../api/client';
import { createRequest, cancelRequest, type Asked } from '../flows/request';
import { cancelUpload, destroySecret, sendSecret, type Sent } from '../flows/send';
import { dateTime, duration, relative } from '../lib/format';
import { t } from '../lib/i18n';
import { navigate, route } from '../lib/router';
import { cfg, toast } from '../lib/state';
import { prefs, receipts } from '../store/db';
import { refreshLinksCount } from './links/sync';
import { Banner, Btn, H1 } from '../ui/bits';
import { AppHeader, host, Page } from '../ui/chrome';
import { Icon } from '../ui/icons';
import { charCount, Composer, emptyComposer, isEmpty, type ComposerState } from './send/Composer';
import { LinkReady } from './send/LinkReady';
import { clampPolicy, defaultPolicy, OptionsPanel, PolicyLine, sendRuleItems, whoLabel, type SendPolicy } from './send/Policy';
import { Sealing, type SealProgress } from './send/Sealing';
import { newRequestDraft, RequestComposer, RequestOptions, requestRuleItems, type RequestDraft } from './request/RequestForm';
import { errorText } from './errors';

type Phase =
  | { k: 'compose' }
  | { k: 'sealing'; progress: SealProgress; offline: boolean }
  | { k: 'error'; message: string }
  | { k: 'sent'; sent: Sent; copied: boolean }
  | { k: 'asked'; asked: Asked; copied: boolean };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Home() {
  const c = cfg();
  const mode = route.value.query.get('mode') === 'request' ? 'request' : 'send';
  const [composer, setComposer] = useState<ComposerState>(emptyComposer);
  const [policy, setPolicy] = useState<SendPolicy>(() => defaultPolicy(c));
  const [req, setReq] = useState<RequestDraft>(() => newRequestDraft(c));
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: 'compose' });
  const [formError, setFormError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | undefined>();
  const [cancelling, setCancelling] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const upload = useRef<{ id: string; token: string } | null>(null);
  const pasteHandler = useRef<(raw: string) => void>(() => undefined);

  // Restore the last-used policy, within today's limits.
  useEffect(() => {
    if (c.demo) return;
    prefs.get<SendPolicy>('policy').then((p) => p && setPolicy(clampPolicy({ ...defaultPolicy(c), ...p }, c))).catch(() => undefined);
  }, []);

  // ⌘/Ctrl+V anywhere on "/" focuses the composer and pastes; ⌘/Ctrl+Enter creates.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (phase.k !== 'compose' || mode !== 'send' || target.closest('input,textarea,[contenteditable]')) return;
      const raw = e.clipboardData?.getData('text/plain');
      if (!raw) return;
      e.preventDefault();
      pasteHandler.current(raw);
      setTimeout(() => (document.querySelector('#composer, .field.edit .v') as HTMLElement | null)?.focus());
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && phase.k === 'compose') {
        e.preventDefault();
        if (mode === 'send') void create();
        else void ask();
      }
    };
    document.addEventListener('paste', onPaste);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('keydown', onKey);
    };
  });

  const setMode = (m: 'send' | 'request') => {
    setOptionsOpen(false);
    setFormError(null);
    navigate(m === 'request' ? '/?mode=request' : '/', { replace: true });
  };

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
    setEmailError(undefined);
    if (isEmpty(composer)) {
      setFormError('Type or paste something to send, or attach a file.');
      document.getElementById('composer')?.focus();
      return;
    }
    if (charCount(composer) > c.limits.max_message_chars) {
      setFormError(t('errors.limit_exceeded', { limit: `${c.limits.max_message_chars.toLocaleString()} characters` }));
      return;
    }
    if (policy.access === 'email' && !EMAIL.test(policy.email.trim())) {
      setOptionsOpen(true);
      setEmailError('Enter the email address that can open it.');
      return;
    }
    if (policy.passphraseOn && policy.passphrase.trim().length < 4) {
      setOptionsOpen(true);
      setFormError('Enter a passphrase of at least 4 characters, or turn it off.');
      return;
    }
    const items = [
      ...(composer.note.trim() ? [{ t: 'note' as const, v: composer.note }] : []),
      ...composer.fields.filter((f) => f.k.trim() || f.v).map((f) => ({ t: 'field' as const, k: f.k.trim() || 'Value', v: f.v, secret: f.secret })),
    ];
    const ctrl = new AbortController();
    abort.current = ctrl;
    setOptionsOpen(false);
    setPhase({ k: 'sealing', progress: { stream: 0, done: 0, total: 1 }, offline: false });
    const onOffline = () => setPhase((p) => (p.k === 'sealing' ? { ...p, offline: true } : p));
    const onOnline = () => setPhase((p) => (p.k === 'sealing' ? { ...p, offline: false } : p));
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    try {
      const sent = await sendSecret(c, { title: composer.title, items, files: composer.files }, {
        views: policy.views, expires_in: policy.expires_in, access: policy.access, email: policy.email.trim(), notify: policy.notify,
        passphrase: policy.passphraseOn ? policy.passphrase : null,
      }, (progress) => setPhase({ k: 'sealing', progress, offline: !navigator.onLine }), ctrl.signal, (id, token) => {
        upload.current = { id, token };
      });
      upload.current = null;
      if (!c.demo) void prefs.set('policy', { ...policy, passphraseOn: false, passphrase: '', email: '' });
      const copied = await tryCopy(sent.link);
      setPhase({ k: 'sent', sent, copied });
      void refreshLinksCount();
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (e instanceof ApiError && e.code === 'rate_limited' && c.demo) {
        navigate('/demo/limit');
        return;
      }
      setPhase({ k: 'error', message: e instanceof ApiError && e.code === 'offline' ? t('send.error_offline', { host: host() }) : errorText(e) });
    } finally {
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

  // ------------------------------------------------------------------ request
  async function ask() {
    setFormError(null);
    const fields = req.fields.map((f) => f.name.trim()).filter(Boolean);
    if (!req.title.trim()) {
      setFormError('Say what you need, for example “AWS read-only keys”.');
      (document.querySelector('.cmp-title input') as HTMLInputElement | null)?.focus();
      return;
    }
    if (!fields.length && !req.files) {
      setFormError('Ask for at least one field, or allow files.');
      return;
    }
    setPhase({ k: 'sealing', progress: { stream: 0, done: 0, total: 1 }, offline: false });
    try {
      const asked = await createRequest(c, { title: req.title.trim(), message: req.message.trim(), fields, files: req.files },
        { expires_in: req.expires_in, keep_answer_s: req.keep, notify: req.notify });
      setPhase({ k: 'asked', asked, copied: await tryCopy(asked.link) });
      void refreshLinksCount();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'rate_limited' && c.demo) {
        navigate('/demo/limit');
        return;
      }
      setPhase({ k: 'compose' });
      setFormError(errorText(e));
    }
  }

  const reset = () => {
    setComposer(emptyComposer());
    setReq(newRequestDraft(c));
    setPhase({ k: 'compose' });
    setTimeout(() => document.getElementById('composer')?.focus());
  };

  // ------------------------------------------------------------------ render
  if (phase.k === 'sent') {
    const s = phase.sent;
    const fields = composer.fields.filter((f) => f.k || f.v).length;
    const contains = t('reveal.contents', { fields, files: composer.files.length, both: fields > 0 && composer.files.length > 0 }) || 'A message';
    return (
      <Page header={<AppHeader active="new" />}>
        <main class="main" id="main">
          <LinkReady copied={phase.copied} copiedLabel={t('send.link_copied')} title={composer.title.trim() || 'Your secret'} status={t('send.waiting')} link={s.link}
            facts={[
              { k: 'Opens', v: policy.views === 1 ? t('policy.once') : t('policy.n_times', { n: policy.views }) },
              { k: 'Expires', v: dateTime(s.expires_at), sub: relative(s.expires_at) },
              { k: 'Who', v: whoLabel({ access: policy.access, email: policy.email }, c.brand.name || 'your organization') },
              { k: 'Contains', v: contains.charAt(0).toUpperCase() + contains.slice(1) },
            ]}
            banner={policy.notify && c.user ? <Banner kind="info" icon="bell"><span dangerouslySetInnerHTML={{ __html: escapeBold(t('send.will_email', { email: c.user.email }), c.user.email) }} /></Banner>
              : <Banner kind="info" icon="link">It shows in <a class="link" href="/links">Your links</a> the moment it’s opened.</Banner>}
            destroyLabel={t('send.destroy_now')} destroyTitle={t('dialog.destroy_title')}
            destroyBody={t('dialog.destroy_body', { title: composer.title.trim() || 'Your secret' })}
            onDestroy={async () => {
              await destroySecret(s.id, s.manage_token);
              await receipts.patch('secret', s.id, { last_status: 'destroyed', link: undefined, ended_at: new Date().toISOString() });
              toast(t('toast.destroyed'));
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

  if (phase.k === 'asked') {
    const a = phase.asked;
    const fields = req.fields.filter((f) => f.name.trim()).length;
    return (
      <Page header={<AppHeader active="new" />}>
        <main class="main" id="main">
          <LinkReady copied={phase.copied} copiedLabel={t('request.copied')} title={req.title} status={t('request.waiting')} link={a.link}
            facts={[
              { k: 'Link works', v: `Until ${dateTime(a.expires_at)}`, sub: 'once' },
              { k: 'Asks for', v: [fields ? `${fields} ${fields === 1 ? 'field' : 'fields'}` : '', req.files ? 'files' : ''].filter(Boolean).join(' and ') },
              { k: 'Answer kept', v: duration(req.keep), sub: 'after it arrives' },
              { k: 'Who can read it', v: 'Only you' },
            ]}
            banner={<Banner kind="info" icon="key">{t('request.key_note')} <button type="button" class="link" onClick={() => {
              void navigator.clipboard.writeText(a.backup).then(() => toast('Backup link copied. Keep it somewhere safe; it opens the answer.'), () => toast('Couldn’t copy the backup link', 'error'));
            }}>{t('request.backup_link')}</button> if you might open it on another device.</Banner>}
            destroyLabel={t('request.cancel')} destroyTitle="Cancel this request?" destroyBody={`“${req.title}” stops working now. Anyone who opens the link will see that you cancelled it.`}
            onDestroy={async () => {
              await cancelRequest(a.id, a.manage_token);
              await receipts.patch('request', a.id, { last_status: 'cancelled', link: undefined, ended_at: new Date().toISOString() });
              toast('Request cancelled');
              reset();
            }}
            actions={<Btn kind="primary" href="/links">{t('send.done')}</Btn>} />
        </main>
      </Page>
    );
  }

  const sealing = phase.k === 'sealing';
  const brand = c.brand.name || 'your organization';
  const quotaLeft = c.quota ? c.quota.limit - c.quota.used : null;

  return (
    <Page header={<AppHeader active="new" />}>
      <main class="main" id="main">
        {phase.k === 'error' && (
          <Banner kind="danger" icon="alert" action={<Btn kind="secondary" class="sm" icon="refresh" onClick={create}>{t('send.try_again')}</Btn>}>{phase.message}</Banner>
        )}
        {!sealing && (
          <div class="mode" role="tablist" aria-label="What to do">
            <button role="tab" aria-selected={mode === 'send'} class={mode === 'send' ? 'on' : ''} onClick={() => setMode('send')}><Icon name="send" size="sm" />{t('send.mode_send')}</button>
            <button role="tab" aria-selected={mode === 'request'} class={mode === 'request' ? 'on' : ''} onClick={() => setMode('request')}><Icon name="inbox" size="sm" />{t('send.mode_request')}</button>
          </div>
        )}
        {!sealing && phase.k !== 'error' && (
          <div class="stack" style="gap:8px">
            <H1>{mode === 'request' ? t('request.title') : c.demo ? t('demo.title') : t('send.title')}</H1>
            <p class="lede" dangerouslySetInnerHTML={{ __html: mode === 'request' ? t('request.lede').replace(' you,', ' <b>you</b>,') : c.demo ? t('demo.lede') : t('send.lede') }} />
          </div>
        )}

        {mode === 'send' ? (
          <>
            <Composer state={composer} onChange={setComposer} maxChars={c.limits.max_message_chars} maxFiles={c.limits.max_files}
              maxFileBytes={c.limits.max_file_bytes} disabled={sealing} demoPlaceholder={c.demo} onFilesRejected={(m) => toast(m, 'error')}
              registerPaste={(fn) => { pasteHandler.current = fn; }} />
            {sealing ? (
              <Sealing files={composer.files} manifestBytes={Math.max(1, phase.progress.total - composer.files.reduce((n, f) => n + f.size, 0))}
                progress={phase.progress} offline={phase.offline} onCancel={cancel} cancelling={cancelling} />
            ) : (
              <>
                {optionsOpen && !c.demo
                  ? <OptionsPanel policy={policy} onChange={setPolicy} onDone={() => setOptionsOpen(false)} cfg={c} emailError={emailError} />
                  : <PolicyLine items={sendRuleItems(policy, brand)} onChange={() => setOptionsOpen(true)} open={optionsOpen} locked={c.demo} />}
                {formError && <p class="err-msg" role="alert"><Icon name="alert" size="sm" />{formError}</p>}
                <div class="actions-m between">
                  <span class="muted small hide-m">
                    {c.demo && quotaLeft !== null ? <><Icon name="clock" size="sm" /> {t('demo.quota', { left: quotaLeft, limit: c.quota!.limit })}</>
                      : optionsOpen ? t('policy.defaults_note') : phase.k === 'error' ? t('send.retry_note') : <><kbd>⌘</kbd> <kbd>Enter</kbd> to create</>}
                  </span>
                  <Btn kind="primary" class="lg" icon={phase.k === 'error' ? 'refresh' : 'link'} onClick={create}>{phase.k === 'error' ? t('send.try_again') : t('send.create')}</Btn>
                </div>
              </>
            )}
            {!sealing && isEmpty(composer) && !c.demo && (
              <div class="how">
                <div><b><Icon name="lock" size="sm" />{t('send.how_encrypted_title')}</b>{t('send.how_encrypted')}</div>
                <div><b><Icon name="eye" size="sm" />{t('send.how_once_title')}</b>{t('send.how_once')}</div>
                <div><b><Icon name="bell" size="sm" />{t('send.how_know_title')}</b>{t('send.how_know')}</div>
              </div>
            )}
            {c.demo && !sealing && (
              <div class="card"><div class="card-b between"><span class="small"><b>Like it?</b> Run your own in one command.</span><span class="mono small">docker run -p 80:80 poliuscorp/cryptex:3</span></div></div>
            )}
          </>
        ) : (
          <>
            <RequestComposer d={req} set={(p) => setReq({ ...req, ...p })} disabled={sealing} maxFiles={c.limits.max_files} />
            <div>
              <label class="label" for="req-message">{t('request.message_label')} <span class="muted" style="font-weight:400">{t('request.optional')}</span></label>
              <textarea id="req-message" class="input textarea" value={req.message} maxLength={2000} disabled={sealing}
                onInput={(e) => setReq({ ...req, message: (e.target as HTMLTextAreaElement).value })} />
            </div>
            {optionsOpen && !c.demo
              ? <RequestOptions d={req} set={(p) => setReq({ ...req, ...p })} cfg={c} onDone={() => setOptionsOpen(false)} />
              : <PolicyLine items={requestRuleItems(req)} onChange={() => setOptionsOpen(true)} open={optionsOpen} locked={c.demo} />}
            {formError && <p class="err-msg" role="alert"><Icon name="alert" size="sm" />{formError}</p>}
            <div class="actions-m between">
              <span class="muted small hide-m">{t('request.only_you')}</span>
              <Btn kind="primary" class="lg" icon="link" loading={sealing} onClick={ask}>{t('request.create')}</Btn>
            </div>
          </>
        )}
      </main>
    </Page>
  );
}

function escapeBold(text: string, bold: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(text).replace(esc(bold), `<b>${esc(bold)}</b>`).replace('Your links', '<b>Your links</b>');
}

