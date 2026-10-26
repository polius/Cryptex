/** The composer (A1–A3): type or paste; pastes are read into fields (frontend.md §5) with Undo. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { bytes } from '../../lib/format';
import { t } from '../../lib/i18n';
import { isSecretKey, parsePaste } from '../../parse/paste';
import { generatePassword } from '../../flows/send';
import { Icon } from '../../ui/icons';

export interface FieldRow {
  id: number;
  k: string;
  v: string;
  secret: boolean;
  shown: boolean;
  generated?: boolean;
}

export interface ComposerState {
  title: string;
  note: string;
  fields: FieldRow[];
  files: File[];
  detected: { count: number; env: boolean; raw: string } | null;
}

export const emptyComposer = (): ComposerState => ({ title: '', note: '', fields: [], files: [], detected: null });

let rowSeq = 0;
export const newRow = (k = '', v = '', secret = false): FieldRow => ({ id: ++rowSeq, k, v, secret, shown: !secret });

export function charCount(s: ComposerState): number {
  return s.note.length + s.fields.reduce((n, f) => n + f.k.length + f.v.length, 0);
}

export function isEmpty(s: ComposerState): boolean {
  return !s.note.trim() && !s.fields.some((f) => f.v || f.k) && !s.files.length;
}

/** Apply a paste: the whole composer content, if it was empty, is parsed (first rule wins). */
export function applyPaste(s: ComposerState, raw: string): ComposerState {
  const p = parsePaste(raw);
  if (p.kind === 'note') return { ...s, note: s.note + raw, detected: null };
  return {
    ...s,
    fields: [...s.fields.filter((f) => f.k || f.v), ...p.fields.map((f) => newRow(f.k, f.v, f.secret))],
    detected: { count: p.fields.length, env: p.rule === 'env', raw },
  };
}

export function Composer(props: {
  state: ComposerState; onChange: (s: ComposerState) => void; maxChars: number; maxFiles: number; maxFileBytes: number;
  disabled?: boolean; demoPlaceholder?: boolean; onFilesRejected: (msg: string) => void; registerPaste: (fn: (raw: string) => void) => void;
}) {
  const s = props.state;
  const set = (p: Partial<ComposerState>) => props.onChange({ ...s, ...p });
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState(false);
  const empty = isEmpty(s) && !s.fields.length;
  const used = charCount(s);
  const over = used > props.maxChars;

  // Pastes anywhere on the page land here (⌘V on /).
  useEffect(() => {
    props.registerPaste((raw) => props.onChange(applyPaste(props.state, raw)));
  });

  // Grow the note box with its content.
  useEffect(() => {
    const el = noteRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.max(el.scrollHeight, empty ? 220 : 72)}px`;
    }
  }, [s.note, empty]);

  const onPaste = (e: ClipboardEvent) => {
    const raw = e.clipboardData?.getData('text/plain') ?? '';
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
      return;
    }
    // Parse only when the paste is the whole content (empty composer); otherwise it's typing.
    if (!s.note.trim() && !s.fields.length && raw) {
      const next = applyPaste(s, raw);
      if (next.fields.length) {
        e.preventDefault();
        props.onChange(next);
      }
    }
  };

  const addFiles = (list: File[]) => {
    const room = props.maxFiles - s.files.length;
    const ok = list.filter((f) => f.size <= props.maxFileBytes).slice(0, Math.max(0, room));
    if (list.some((f) => f.size > props.maxFileBytes)) props.onFilesRejected(t('errors.too_large', { limit: bytes(props.maxFileBytes) }));
    else if (list.length > room) props.onFilesRejected(`Up to ${props.maxFiles} ${props.maxFiles === 1 ? 'file' : 'files'} per link.`);
    if (ok.length) set({ files: [...s.files, ...ok] });
  };

  const updateRow = (id: number, p: Partial<FieldRow>) => set({ fields: s.fields.map((f) => (f.id === id ? { ...f, ...p } : f)), detected: s.detected });
  const removeRow = (id: number) => set({ fields: s.fields.filter((f) => f.id !== id) });
  const undo = () => props.onChange({ ...s, fields: [], note: s.detected?.raw ?? '', detected: null });

  return (
    <section class={`composer${focus ? ' focus' : ''}`} aria-label={t('send.title')}
      onFocusIn={() => setFocus(true)} onFocusOut={() => setFocus(false)}
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(Array.from(e.dataTransfer?.files ?? [])); }}>
      {!empty && (
        <div class="cmp-title">
          <input class="t" value={s.title} maxLength={120} placeholder={t('send.title_placeholder')} aria-label="Title" disabled={props.disabled}
            onInput={(e) => set({ title: (e.target as HTMLInputElement).value })} />
          <p class="hint"><Icon name="lock" size="sm" />{t('send.title_hint')}</p>
        </div>
      )}
      {(empty || s.note || !s.fields.length) && (
        <div class={empty ? 'cmp-empty' : 'cmp-note'}>
          <textarea ref={noteRef} class={empty ? 'ph-area' : 'note-area'} value={s.note} disabled={props.disabled} id="composer"
            aria-label="Secret" spellcheck={false} autoComplete="off" data-autofocus
            placeholder={props.demoPlaceholder ? t('demo.placeholder') : t('send.placeholder')}
            onPaste={onPaste} onInput={(e) => set({ note: (e.target as HTMLTextAreaElement).value, detected: null })} />
          {empty && !props.demoPlaceholder && (
            <div class="examples" aria-hidden="true"><span class="ex">DB_PASSWORD=…</span><span class="ex">user / password</span><span class="ex">-----BEGIN OPENSSH…</span></div>
          )}
        </div>
      )}
      {s.fields.length > 0 && (
        <div class="items">
          {s.fields.map((f, i) => (
            <div class="field edit" key={f.id}>
              <span class="k">
                <input value={f.k} placeholder="Name" aria-label={`Field ${i + 1} name`} disabled={props.disabled} maxLength={80}
                  onInput={(e) => {
                    const k = (e.target as HTMLInputElement).value;
                    updateRow(f.id, { k, secret: f.secret || isSecretKey(k) });
                  }} />
                {f.generated && <span class="tag">generated</span>}
              </span>
              <input class={`v${f.secret && !f.shown ? ' secret' : ''}`} type={f.secret && !f.shown ? 'password' : 'text'} value={f.v}
                placeholder="Value" aria-label={`${f.k || `Field ${i + 1}`} value`} disabled={props.disabled} autoComplete="off" spellcheck={false}
                onInput={(e) => updateRow(f.id, { v: (e.target as HTMLInputElement).value, generated: false })} />
              <span class="acts">
                {f.secret && (
                  <button type="button" class="btn icon sm ghost" aria-label={f.shown ? t('reveal.hide') : t('reveal.show')} title={f.shown ? t('reveal.hide') : t('reveal.show')}
                    onClick={() => updateRow(f.id, { shown: !f.shown })}><Icon name={f.shown ? 'eyeoff' : 'eye'} size="sm" /></button>
                )}
                {/pass|pwd|secret/i.test(f.k) && (
                  <button type="button" class="btn sm ghost" onClick={() => updateRow(f.id, { v: generatePassword(), generated: true, secret: true })}>{t('send.generate')}</button>
                )}
                <button type="button" class="btn icon sm ghost" aria-label="Remove field" title="Remove field" onClick={() => removeRow(f.id)}><Icon name="x" size="sm" /></button>
              </span>
            </div>
          ))}
        </div>
      )}
      {s.files.length > 0 && (
        <div class="files">
          {s.files.map((f, i) => (
            <span class="file" key={`${f.name}-${i}`}>
              <Icon name="file" size="sm" />{f.name} <small>{bytes(f.size)}</small>
              <button type="button" class="btn icon sm ghost" aria-label={`Remove ${f.name}`} title="Remove file" disabled={props.disabled}
                onClick={() => set({ files: s.files.filter((_, j) => j !== i) })}><Icon name="x" size="sm" /></button>
            </span>
          ))}
        </div>
      )}
      <div class="cmp-bar">
        <input ref={fileRef} type="file" multiple class="sr" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { addFiles(Array.from((e.target as HTMLInputElement).files ?? [])); (e.target as HTMLInputElement).value = ''; }} />
        {props.maxFiles > 0 && (
          <button type="button" class="btn sm ghost" disabled={props.disabled || s.files.length >= props.maxFiles} onClick={() => fileRef.current?.click()}>
            <Icon name="clip" size="sm" />{props.demoPlaceholder ? `Attach (${props.maxFiles} file, ${bytes(props.maxFileBytes)})` : empty ? t('send.attach') : 'Attach'}
          </button>
        )}
        <button type="button" class="btn sm ghost" disabled={props.disabled} onClick={() => {
          set({ fields: [...s.fields, newRow()] });
          setTimeout(() => (document.querySelector('.field.edit:last-child .k input') as HTMLInputElement | null)?.focus());
        }}><Icon name="plus" size="sm" />{t('send.add_field')}</button>
        <span class="sp" />
        {s.detected ? (
          <span class="detected" role="status">
            <Icon name="scan" size="sm" />
            {s.detected.env ? t('send.detected_env') : t('send.detected', { count: s.detected.count })} · <button type="button" class="link" onClick={undo}>{t('send.undo')}</button>
          </span>
        ) : empty ? (
          <span class="detected hide-m">{props.demoPlaceholder ? `${props.maxChars} characters max` : t('send.drop_hint')}</span>
        ) : (
          <span class={`detected counter${over ? ' over' : ''}`} aria-live="polite">
            {t('send.counter', { used: used.toLocaleString(), max: props.maxChars.toLocaleString(), files: s.files.length, maxFiles: props.maxFiles })}
          </span>
        )}
      </div>
    </section>
  );
}
