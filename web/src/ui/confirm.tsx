/** Promise-based confirmation using the app's dialog (no native confirm()). */
import { signal } from '@preact/signals';
import { t } from '../lib/i18n';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Btn, copyFallback, copyHint } from './bits';
import { Dialog } from './dialog';

interface Ask {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  /** A checkbox in the dialog (on by default when `on`), its state returned with the answer: confirmChoice. */
  choice?: { label: string; on: boolean };
  resolve: (ok: boolean, choice: boolean) => void;
}

const current = signal<Ask | null>(null);

export function confirmDialog(o: Omit<Ask, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    current.value = { ...o, resolve: (ok) => resolve(ok) };
  });
}

/** A confirmation with one checkbox: whether it was confirmed, and the box's state. */
export function confirmChoice(o: Omit<Ask, 'resolve'> & { choice: { label: string; on: boolean } }): Promise<{ ok: boolean; choice: boolean }> {
  return new Promise((resolve) => {
    current.value = { ...o, resolve: (ok, choice) => resolve({ ok, choice }) };
  });
}

export function ConfirmHost() {
  const a = current.value;
  const [on, setOn] = useState(false);
  useEffect(() => setOn(!!a?.choice?.on), [a]);
  const done = (ok: boolean) => {
    a?.resolve(ok, on);
    current.value = null;
  };
  return (
    <Dialog open={!!a} alert onClose={() => done(false)} labelledBy="confirm-title"
      footer={<><button class="btn secondary" onClick={() => done(false)} data-autofocus>{t('send.cancel')}</button>
        <Btn kind={a?.danger ? 'danger solid' : 'primary'} onClick={() => done(true)}>{a?.confirm}</Btn></>}>
      <h2 class="h2" id="confirm-title">{a?.title}</h2>
      <p class="muted">{a?.body}</p>
      {a?.choice && (
        <label class="check-line"><input type="checkbox" checked={on} onChange={(e) => setOn((e.target as HTMLInputElement).checked)} /> {a.choice.label}</label>
      )}
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
