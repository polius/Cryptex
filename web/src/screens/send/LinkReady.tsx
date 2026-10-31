/** A5–A7: the link is ready (a secret's, or a request's) (copied when possible), facts, QR and destroy/cancel. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../lib/i18n';
import { Btn, copyText, ErrMsg, H1, Status } from '../../ui/bits';
import { errorText } from '../errors';
import { Dialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { QR } from '../../ui/qr';

/** The phone's own share sheet (Messages, WhatsApp, Mail…), where the browser has one. */
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

export function LinkBox({ link }: { link: string }) {
  const urlRef = useRef<HTMLSpanElement>(null);
  const [qr, setQr] = useState(false);
  const hashAt = link.indexOf('#');
  const shown = link.replace(/^https?:\/\//, '');
  const base = shown.slice(0, shown.indexOf('#'));
  const frag = link.slice(hashAt + 1);
  return (
    <>
      <div class="linkbox">
        <span class="url" ref={urlRef} title={link}>
          <span class="sr">{link}</span>
          <span aria-hidden="true">{base}<span class="frag">#<span class="frag-head">{frag.slice(0, 6)}</span>…{frag.slice(-4)}</span></span>
        </span>
        <Btn kind="primary" icon="copy" onClick={() => copyText(link, t('toast.link_copied'), urlRef.current)}>{t('reveal.copy')}</Btn>
        {canShare && <Btn kind="secondary" icon="share" onClick={() => void navigator.share({ url: link }).catch(() => undefined)}>{t('send.share')}</Btn>}
        <Btn kind="secondary" class="icon" label={t('send.qr')} onClick={() => setQr(true)}><Icon name="qr" size="sm" /></Btn>
      </div>
      <Dialog open={qr} onClose={() => setQr(false)} labelledBy="qr-title">
        <div class="between">
          <h2 class="h3" id="qr-title">{t('dialog.qr_title')}</h2>
          <button type="button" class="btn icon sm ghost" aria-label={t('dialog.close')} title={t('dialog.close')} onClick={() => setQr(false)} data-autofocus><Icon name="x" size="sm" /></button>
        </div>
        <div class="qrbox"><QR text={link} label={t('dialog.qr_label')} /></div>
        <p class="fine">{t('dialog.qr_note')}</p>
      </Dialog>
    </>
  );
}

export function LinkReady(props: {
  copied: boolean; copiedLabel: string; title: string; status: string; link: string; facts: Array<{ k: string; v: string; sub?: string }>;
  /** Shown under the link with its own Copy button, to send another way. */
  passphrase?: string | null; banner?: ComponentChildren; destroyLabel: string;
  /** What to do with the link (default: paste it into a chat or email). */
  hint?: string; destroyTitle: string; destroyBody: string; onDestroy: () => Promise<void>;
  actions: ComponentChildren;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const head = useRef<HTMLDivElement>(null);
  // The button that made the link is gone: focus the new page's heading, then fill the status in, so a screen
  // reader hears "Link copied" (a live region that arrives already filled often isn't read).
  const [said, setSaid] = useState(false);
  useEffect(() => {
    head.current?.querySelector<HTMLElement>('[data-page-heading]')?.focus({ preventScroll: true });
    const id = setTimeout(() => setSaid(true), 150);
    return () => clearTimeout(id);
  }, []);
  const close = () => {
    setConfirm(false);
    setErr(null);
  };
  const destroy = async () => {
    setBusy(true);
    setErr(null);
    try {
      await props.onDestroy();
      setConfirm(false);
    } catch (e) {
      setErr(errorText(e)); // the link still works: say so where they're looking, and let them try again
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div class="stack" style="gap:10px" ref={head}>
        <span class={`copied${props.copied ? '' : ' manual'}`} role="status">{said && (props.copied
          ? <><Icon name="check" />{props.copiedLabel}</> : <><Icon name="arrow" />{t('send.copy_manually')}</>)}</span>
        <H1>{props.title}</H1>
        <Status kind="waiting">{props.status}</Status>
      </div>
      <div class="stack" style="gap:10px">
        <LinkBox link={props.link} />
        <p class="muted small">{props.hint ?? t('send.share_hint')}</p>
      </div>
      {props.passphrase && (
        <div class="stack" style="gap:10px">
          <div class="linkbox pass-ready">
            <span class="pass-k"><Icon name="key" size="sm" />{t('policy.passphrase')}</span>
            <span class="url mono">{props.passphrase}</span>
            <Btn kind="secondary" icon="copy" onClick={() => copyText(props.passphrase!)}>{t('reveal.copy')}</Btn>
          </div>
          <p class="muted small">{t('send.passphrase_tell')}</p>
        </div>
      )}
      <div class="facts">
        {props.facts.map((f) => <div key={f.k}><small>{f.k}</small><b>{f.v}</b>{f.sub && <span>{f.sub}</span>}</div>)}
      </div>
      {props.banner}
      <button type="button" class="btn danger sm show-m" style="justify-self:start" onClick={() => setConfirm(true)}><Icon name="trash" size="sm" />{props.destroyLabel}</button>
      <div class="actions-m between">
        <button type="button" class="btn danger hide-m" onClick={() => setConfirm(true)}><Icon name="trash" size="sm" />{props.destroyLabel}</button>
        <div class="row">{props.actions}</div>
      </div>
      <Dialog open={confirm} alert onClose={close} labelledBy="destroy-title"
        footer={<>
          <button type="button" class="btn secondary" onClick={close} data-autofocus>{t('dialog.destroy_keep')}</button>
          <Btn kind="danger solid" icon="trash" loading={busy} onClick={destroy}>{err ? t('send.try_again') : props.destroyLabel}</Btn>
        </>}>
        <h2 class="h2" id="destroy-title">{props.destroyTitle}</h2>
        <p class="muted">{props.destroyBody}</p>
        {err && <ErrMsg>{err}</ErrMsg>}
      </Dialog>
    </>
  );
}
