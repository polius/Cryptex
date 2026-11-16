/** Promise-based confirmation using the app's dialog (no native confirm()). */
import { signal } from '@preact/signals';
import { t } from '../lib/i18n';
import { useEffect, useRef } from 'preact/hooks';
import { Btn, copyFallback, copyHint } from './bits';
import { Dialog } from './dialog';

interface Ask {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const current = signal<Ask | null>(null);

export function confirmDialog(o: Omit<Ask, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    current.value = { ...o, resolve };
  });
}

export function ConfirmHost() {
  const a = current.value;
  const done = (ok: boolean) => {
    a?.resolve(ok);
    current.value = null;
  };
  return (
    <Dialog open={!!a} alert onClose={() => done(false)} labelledBy="confirm-title"
      footer={<><button class="btn secondary" onClick={() => done(false)} data-autofocus>{t('send.cancel')}</button>
        <Btn kind={a?.danger ? 'danger solid' : 'primary'} onClick={() => done(true)}>{a?.confirm}</Btn></>}>
      <h2 class="h2" id="confirm-title">{a?.title}</h2>
      <p class="muted">{a?.body}</p>
    </Dialog>
  );
}

/** The clipboard was refused: the text, selected, to copy by hand. */
export function CopyFallbackHost() {
  const text = copyFallback.value;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (text !== null) requestAnimationFrame(() => ref.current?.select());
  }, [text]);
  const close = () => (copyFallback.value = null);
  return (
    <Dialog open={text !== null} onClose={close} labelledBy="copy-title"
      footer={<button class="btn secondary" onClick={close}>{t('dialog.close')}</button>}>
      <h2 class="h3" id="copy-title">{t('dialog.copy_title')}</h2>
      <p class="muted small">{copyHint()}</p>
      <textarea ref={ref} class="input textarea mono" readOnly rows={Math.min(6, (text ?? '').split('\n').length)} value={text ?? ''} aria-labelledby="copy-title"
        onFocus={(e) => (e.target as HTMLTextAreaElement).select()} data-autofocus />
    </Dialog>
  );
}
