/** /q/:id#key (C3–C4): answer a request. Encrypted on this device for the requester only. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { importBackupKey, KeyMismatch, loadPrompt, sendAnswer, type LoadedPrompt } from '../../flows/request';
import { bytes, dateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { dropFragment, navigate } from '../../lib/router';
import { config, toast } from '../../lib/state';
import { Banner, Btn, ErrMsg, H1, Status } from '../../ui/bits';
import { host, Page, RecipientHeader } from '../../ui/chrome';
import { Icon } from '../../ui/icons';
import { errorText } from '../errors';

type State =
  | { k: 'loading' }
  | { k: 'broken' }
  | { k: 'mismatch'; sender: string }
  | { k: 'gone'; reason: string }
  | { k: 'missing' }
  | { k: 'form'; lp: LoadedPrompt }
  | { k: 'done'; sender: string }
  | { k: 'error'; message: string };

let initialFragment: string | null = null;

export function Respond({ id }: { id: string }) {
  const [s, setS] = useState<State>({ k: 'loading' });
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const [extra, setExtra] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frag = initialFragment ?? location.hash.slice(1);
    initialFragment = frag;
    loadPrompt(id, frag).then((lp) => setS({ k: 'form', lp }), (e) => {
      if ((e as Error).message === 'incomplete_link') setS({ k: 'broken' });
      else if (e instanceof KeyMismatch) setS({ k: 'mismatch', sender: 'the requester' });
      else if (e instanceof ApiError && e.code === 'gone') setS({ k: 'gone', reason: e.reason ?? 'answered' });
      else if (e instanceof ApiError && e.code === 'not_found') setS({ k: 'missing' });
      else setS({ k: 'error', message: errorText(e) });
    });
    return () => {
      initialFragment = null;
    };
  }, [id]);

  const page = (body: preact.ComponentChildren, narrowStyle?: string) => (
    <Page header={<RecipientHeader />} demoRecipient>
      <main class="main narrow" id="main" style={narrowStyle}>{body}</main>
    </Page>
  );
  const brand = config.value?.brand.name || host();

  if (s.k === 'loading') return page(<div class="skeleton h1" aria-busy="true" />);
  if (s.k === 'broken') return page(<><Status kind="danger">Link incomplete</Status><H1>{t('reveal.broken_title')}</H1><p class="lede">Apps sometimes cut long links. Copy the whole link again, including everything after <span class="mono">#</span>. Nothing was sent.</p></>);
  if (s.k === 'mismatch') return page(<><Status kind="danger">Can’t answer safely</Status><H1>This request can’t be answered</H1><Banner kind="danger" icon="alert">{t('respond.key_mismatch', { sender: s.sender })}</Banner></>);
  if (s.k === 'missing') return page(<><H1>{t('errors.not_found')}</H1><p class="lede">If someone sent you a link, it may be incomplete. Copy the whole link again, including everything after <span class="mono">#</span>.</p></>);
  if (s.k === 'gone') {
    return page(<><Status kind="expired">{s.reason === 'answered' ? 'Already answered' : s.reason === 'cancelled' ? 'Cancelled' : 'Expired'}</Status>
      <H1>{s.reason === 'answered' ? t('errors.already_answered') : s.reason === 'cancelled' ? 'This request was cancelled' : 'This request expired'}</H1>
      <p class="lede">{s.reason === 'answered' ? 'Each request link works once. If you didn’t answer it, tell the person who asked.' : 'Ask the person who sent it for a new link.'}</p></>);
  }
  if (s.k === 'error') return page(<Banner kind="danger" icon="alert">{s.message}</Banner>);
  if (s.k === 'done') {
    return page(<>
      <span class="avatar big ok" aria-hidden="true"><Icon name="check" size="lg" /></span>
      <H1>{t('respond.sent_title', { sender: s.sender })}</H1>
      <p class="lede">{t('respond.sent_body', { sender: s.sender })}</p>
      <a class="btn secondary" href="/">{t('respond.own')} <Icon name="arrow" size="sm" /></a>
    </>, 'text-align:center;justify-items:center;padding-top:96px');
  }

  const { prompt, limits, expires_at } = s.lp;
  const sender = prompt.from || 'Someone';
  const first = sender.split(' ')[0];
  const filled = prompt.fields.every((f) => (values[f] ?? '').trim()) || (!prompt.fields.length && (files.length || note.trim()));

  const submit = async () => {
    setErr(null);
    if (!filled) {
      setErr('Fill in every field before sending.');
      return;
    }
    const chars = prompt.fields.reduce((n, f) => n + (values[f] ?? '').length, note.length);
    if (chars > limits.max_message_chars) {
      setErr(t('errors.limit_exceeded', { limit: `${limits.max_message_chars.toLocaleString()} characters` }));
      return;
    }
    setBusy(true);
    try {
      await sendAnswer(config.value!, id, s.lp, [
        ...prompt.fields.map((k) => ({ t: 'field' as const, k, v: values[k] ?? '', secret: true })),
        ...(note.trim() ? [{ t: 'note' as const, v: note }] : []),
      ], files, (d, total) => setPct(Math.round((100 * d) / total)));
      dropFragment();
      setS({ k: 'done', sender: first });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return page(<>
    <p class="from"><b>{sender}</b>{config.value?.brand.name ? ` at ${brand}` : ''} is asking you for</p>
    <H1>{prompt.title}</H1>
    {prompt.message && <p class="quote">“{prompt.message}”<small>{t('respond.their_message', { sender: first })}</small></p>}
    {prompt.fields.map((f, i) => (
      <div key={f}>
        <label class="label" for={`f${i}`}>{f}</label>
        <div class="input mono">
          <input id={`f${i}`} class="bare" type={shown[f] ? 'text' : 'password'} value={values[f] ?? ''} autoComplete="off" spellcheck={false} data-autofocus={i === 0 || undefined}
            onInput={(e) => setValues({ ...values, [f]: (e.target as HTMLInputElement).value })} disabled={busy} />
          <button type="button" class="btn icon sm ghost" aria-label={shown[f] ? t('reveal.hide') : t('reveal.show')} onClick={() => setShown({ ...shown, [f]: !shown[f] })}>
            <Icon name={shown[f] ? 'eyeoff' : 'eye'} size="sm" />
          </button>
        </div>
      </div>
    ))}
    {extra || !prompt.fields.length ? (
      <>
        <div>
          <label class="label" for="note">Note <span class="muted" style="font-weight:400">{t('request.optional')}</span></label>
          <textarea id="note" class="input textarea" value={note} disabled={busy} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
        </div>
        {prompt.files && limits.max_files > 0 && (
          <div class="stack" style="gap:8px">
            <input ref={fileRef} type="file" multiple class="sr" tabIndex={-1} aria-hidden="true" onChange={(e) => {
              const list = Array.from((e.target as HTMLInputElement).files ?? []);
              const ok = list.filter((f) => f.size <= limits.max_file_bytes);
              if (ok.length < list.length) toast(t('errors.too_large', { limit: bytes(limits.max_file_bytes) }), 'error');
              setFiles([...files, ...ok].slice(0, limits.max_files));
            }} />
            {files.length > 0 && <div class="files">{files.map((f, i) => (
              <span class="file" key={i}><Icon name="file" size="sm" />{f.name} <small>{bytes(f.size)}</small>
                <button type="button" class="btn icon sm ghost" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="x" size="sm" /></button></span>
            ))}</div>}
            <button type="button" class="btn ghost sm" style="justify-self:start" disabled={busy || files.length >= limits.max_files} onClick={() => fileRef.current?.click()}><Icon name="clip" size="sm" />Attach files</button>
          </div>
        )}
      </>
    ) : (
      <button type="button" class="btn ghost sm" style="justify-self:start" onClick={() => setExtra(true)}><Icon name="plus" size="sm" />{t('respond.add_more')}</button>
    )}
    <Banner kind="ok" icon="lock">{t('respond.lock_note', { sender: first, brand })}</Banner>
    {err && <ErrMsg>{err}</ErrMsg>}
    <div class="actions-m"><Btn kind="primary" class="lg full" icon="send" loading={busy} onClick={submit}>{busy && pct ? `Encrypting and sending ${pct}%` : t('respond.send', { sender: first })}</Btn></div>
    <p class="fine">{t('respond.expires', { date: dateTime(expires_at) })}</p>
  </>);
}

/** /q/:id/key#pkcs8: import a request backup key into this browser, then go to Your links. */
export function KeyImport({ id }: { id: string }) {
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const frag = location.hash.slice(1);
    dropFragment();
    importBackupKey(id, frag).then(() => {
      toast('Backup key added. You can open the answer on this device.');
      navigate(`/links`, { replace: true });
    }, () => setErr('That backup link is incomplete or damaged.'));
  }, [id]);
  return (
    <Page header={<RecipientHeader />}>
      <main class="main narrow" id="main">{err ? <><H1>Couldn’t add the key</H1><Banner kind="danger" icon="alert">{err}</Banner></> : <p class="muted">Adding the key…</p>}</main>
    </Page>
  );
}
