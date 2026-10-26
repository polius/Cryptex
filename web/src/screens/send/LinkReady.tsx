/** A5–A7 and C2: the link is ready (copied when possible), facts, QR and destroy/cancel. */
import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { t } from '../../lib/i18n';
import { Btn, copyText, H1, Status } from '../../ui/bits';
import { Dialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { QR } from '../../ui/qr';

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
          <span aria-hidden="true">{base}<span class="frag">#{frag.slice(0, 6)}…{frag.slice(-4)}</span></span>
        </span>
        <Btn kind="primary" icon="copy" onClick={() => copyText(link, t('toast.link_copied'), urlRef.current)}>{t('reveal.copy')}</Btn>
        <Btn kind="secondary" class="icon" label={t('send.qr')} onClick={() => setQr(true)}><Icon name="qr" size="sm" /></Btn>
      </div>
      <Dialog open={qr} onClose={() => setQr(false)} labelledBy="qr-title">
        <div class="between">
          <h2 class="h3" id="qr-title">{t('dialog.qr_title')}</h2>
          <button type="button" class="btn icon sm ghost" aria-label={t('dialog.close')} title={t('dialog.close')} onClick={() => setQr(false)} data-autofocus><Icon name="x" size="sm" /></button>
        </div>
        <div class="qrbox"><QR text={link} label="QR code for the link" /></div>
        <p class="fine">{t('dialog.qr_note')}</p>
      </Dialog>
    </>
  );
}

export function LinkReady(props: {
  copied: boolean; copiedLabel: string; title: string; status: string; link: string; facts: Array<{ k: string; v: string; sub?: string }>;
  banner?: ComponentChildren; destroyLabel: string; destroyTitle: string; destroyBody: string; onDestroy: () => Promise<void>;
  actions: ComponentChildren;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div class="stack" style="gap:10px">
        {props.copied ? <span class="copied" role="status"><Icon name="check" />{props.copiedLabel}</span>
          : <span class="copied manual" role="status"><Icon name="arrow" />{t('send.copy_manually')}</span>}
        <H1>{props.title}</H1>
        <Status kind="waiting">{props.status}</Status>
      </div>
      <LinkBox link={props.link} />
      <div class="facts">
        {props.facts.map((f) => <div key={f.k}><small>{f.k}</small><b>{f.v}</b>{f.sub && <span>{f.sub}</span>}</div>)}
      </div>
      {props.banner}
      <button type="button" class="btn danger sm show-m" style="justify-self:start" onClick={() => setConfirm(true)}><Icon name="trash" size="sm" />{props.destroyLabel}</button>
      <div class="actions-m between">
        <button type="button" class="btn danger hide-m" onClick={() => setConfirm(true)}><Icon name="trash" size="sm" />{props.destroyLabel}</button>
        <div class="row">{props.actions}</div>
      </div>
      <Dialog open={confirm} alert onClose={() => setConfirm(false)} labelledBy="destroy-title"
        footer={<>
          <button type="button" class="btn secondary" onClick={() => setConfirm(false)} data-autofocus>{t('dialog.destroy_keep')}</button>
          <Btn kind="danger solid" icon="trash" loading={busy} onClick={async () => {
            setBusy(true);
            try {
              await props.onDestroy();
            } finally {
              setBusy(false);
              setConfirm(false);
            }
          }}>{t('dialog.destroy_confirm')}</Btn>
        </>}>
        <h2 class="h2" id="destroy-title">{props.destroyTitle}</h2>
        <p class="muted">{props.destroyBody}</p>
      </Dialog>
    </>
  );
}
