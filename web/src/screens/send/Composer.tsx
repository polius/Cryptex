/** The composer (A1–A3): type or paste; pastes are read into fields with Undo. */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { bytes, num } from '../../lib/format';
import { t } from '../../lib/i18n';
import { isPasswordKey, isSecretKey, parsePaste } from '../../parse/paste';
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
  /** The last paste that was read into fields: `raw` as pasted, `before` the note and fields it was added to. */
  detected: { count: number; env: boolean; raw: string; before: Pick<ComposerState, 'note' | 'fields'> } | null;
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

/** Apply a paste: it's parsed (first rule wins) and its fields are added after what's there. */
export function applyPaste(s: ComposerState, raw: string): ComposerState {
  const p = parsePaste(raw);
  if (p.kind === 'note') return { ...s, note: s.note + raw, detected: null };
  return {
    ...s,
    fields: [...s.fields.filter((f) => f.k || f.v), ...p.fields.map((f) => newRow(f.k, f.v, f.secret))],
    detected: { count: p.fields.length, env: p.rule === 'env', raw, before: { note: s.note, fields: s.fields } },
  };
}

/** Undo reading a paste into fields: what was there before stays, and the paste is added as text instead. */
export function undoPaste(s: ComposerState): ComposerState {
  if (!s.detected) return s;
  return { ...s, fields: s.detected.before.fields, note: s.detected.before.note + s.detected.raw, detected: null };
}

/** A file's name cut in the middle when it doesn't fit, so its end (the extension) always shows: "a-very-long….pdf". */
export function FileName({ name }: { name: string }) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  const tail = ext || name.slice(-Math.min(6, Math.floor(name.length / 3)));
  return (
    <span class="fname" title={name}>
      <span class="fname-start">{name.slice(0, name.length - tail.length)}</span><span class="fname-end">{tail}</span>
    </span>
  );
}

/** In the large editor the page scrolls, not the text box: keep the cursor in view while typing at the end. */
function followCaret(el: HTMLTextAreaElement) {
  const box = el.closest('.composer');
  if (box && el.selectionEnd === el.value.length) box.scrollTop = box.scrollHeight;
}

/** A page built around a composer (sending, answering a request): text pasted outside a field goes into it, and files
 *  dropped anywhere on the page are attached. `on`: it can take them now (not while sealing). A dropped file never
 *  replaces the page, even then. Returns whether files are being dragged over it, for <DropZone>. */
export function usePageInput(on: boolean, paste: { current: (raw: string) => void }, drop: { current: (files: File[]) => void }): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const onPaste = (e: ClipboardEvent) => {
      if (!on || (e.target as HTMLElement).closest('input,textarea,[contenteditable]')) return;
      const raw = e.clipboardData?.getData('text/plain');
      if (!raw) return;
      e.preventDefault();
      paste.current(raw);
      setTimeout(() => (document.querySelector('.editor #composer-big, .editor .field.edit .v, #composer, .field.edit .v') as HTMLElement | null)?.focus());
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (on) setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      if (on) drop.current(Array.from(e.dataTransfer!.files));
    };
    document.addEventListener('paste', onPaste);
    document.addEventListener('dragover', onOver);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('dragover', onOver);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, [on]);
  return on && dragging;
}

/** "Drop files to attach" over the whole page while files are dragged over it. */
export function DropZone({ on }: { on: boolean }) {
  return on ? <div class="dropzone" aria-hidden="true"><span><Icon name="upload" size="lg" />{t('send.drop_overlay')}</span></div> : null;
}

export function Composer(props: {
  state: ComposerState; onChange: (s: ComposerState) => void; maxChars: number; maxFiles: number; maxFileBytes: number;
  disabled?: boolean; onFilesRejected: (msg: string) => void; registerPaste: (fn: (raw: string) => void) => void;
  registerDrop?: (fn: (files: File[]) => void) => void;
  /** The large editor (Expanded.tsx): fills its container, no auto-grow, `trailing` ends the toolbar. */
  expanded?: boolean; onExpand?: () => void; trailing?: ComponentChildren;
  /** Covers the whole composer, e.g. the seal while a link is made. */
  overlay?: ComponentChildren;
}) {
  const s = props.state;
  const set = (p: Partial<ComposerState>) => {
    const next = { ...s, ...p };
    // Emptying the box (no text, fields or files) also clears the title, whose row hides with it: a fresh start.
    props.onChange(isEmpty(next) && !next.fields.length ? { ...next, title: '' } : next);
  };
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const [focus, setFocus] = useState(false);
  const [titleFocus, setTitleFocus] = useState(false);
  const empty = isEmpty(s) && !s.fields.length;
  const used = charCount(s);
  const over = used > props.maxChars;
  const near = used >= props.maxChars * 0.9; // only then is the count worth announcing

  // Pastes anywhere on the page land here (⌘V on /).
  useEffect(() => {
    props.registerPaste((raw) => props.onChange(applyPaste(props.state, raw)));
    props.registerDrop?.((files) => addFiles(files));
  });

  // In the large editor, start typing where the text ends.
  useEffect(() => {
    const el = noteRef.current;
    if (props.expanded && el) {
      el.setSelectionRange(el.value.length, el.value.length);
      requestAnimationFrame(() => followCaret(el)); // after the box has grown to its text
    }
  }, []);

  // "Or drop files here" shows only when it fits on the toolbar's line; in narrow windows it would push Create link down.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const fit = () => {
      const hint = bar.querySelector<HTMLElement>('.drop-only');
      const first = bar.querySelector<HTMLElement>('.btn');
      if (!hint || !first) return;
      delete hint.dataset.noRoom;
      if (getComputedStyle(hint).display === 'none') return;
      if ((hint.closest('.cmp-end') as HTMLElement).getBoundingClientRect().top >= first.getBoundingClientRect().bottom) hint.dataset.noRoom = '';
    };
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [empty]);

  // Grow the note box with its content, before the browser paints, so the box never shows a wrong height for a frame.
  useLayoutEffect(() => {
    const el = noteRef.current;
    if (el) {
      el.style.height = 'auto';
      // The large editor scrolls as one page: the box grows with the text and flex fills any spare room.
      // Next to fields the note starts as one line ("Add a note") and grows only with its own text.
      // Otherwise the CSS min-heights set the size, so the box keeps its height when the title row appears.
      const min = props.expanded || s.fields.length ? 0 : empty ? (matchMedia('(max-width:720px)').matches ? 130 : 150) : 0;
      el.style.height = `${Math.max(el.scrollHeight, min)}px`;
      if (props.expanded && document.activeElement === el) followCaret(el);
    }
  }, [s.note, empty, s.fields.length]);

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
    else if (list.length > room) props.onFilesRejected(t('send.max_files', { n: props.maxFiles }));
    if (ok.length) set({ files: [...s.files, ...ok] });
  };

  const updateRow = (id: number, p: Partial<FieldRow>) => set({ fields: s.fields.map((f) => (f.id === id ? { ...f, ...p } : f)), detected: s.detected });
  const removeRow = (id: number) => set({ fields: s.fields.filter((f) => f.id !== id) });
  const undo = () => props.onChange(undoPaste(s));

  return (
    <section ref={rootRef} class={`composer${focus ? ' focus' : ''}${props.expanded ? ' big' : ''}`} aria-label={t('send.title')}
      onFocusIn={() => setFocus(true)} onFocusOut={() => setFocus(false)}
      >
      {!empty && (
        <div class="cmp-title">
          <input class="t" value={s.title} maxLength={120} placeholder={t('send.title_placeholder')} aria-label={t('send.title_label')} disabled={props.disabled}
            aria-describedby="title-hint" onFocus={() => setTitleFocus(true)} onBlur={() => setTitleFocus(false)}
            onInput={(e) => set({ title: (e.target as HTMLInputElement).value })} />
          {/* Only while editing the title: that's when "they'll see this first" matters. It slides, so nothing jumps. */}
          <div class={`hint-wrap${titleFocus ? ' on' : ''}`}>
            <p class="hint" id="title-hint"><Icon name="eye" size="sm" />{t('send.title_hint')}</p>
          </div>
        </div>
      )}
      {/* Always there, so a note can be added next to fields (Add field on an empty box used to hide it). */}
      <div class={empty ? 'cmp-empty' : 'cmp-note'}>
        <textarea ref={noteRef} class={empty ? 'ph-area' : `note-area${s.fields.length ? ' slim' : ''}`} value={s.note} disabled={props.disabled} id={props.expanded ? 'composer-big' : 'composer'}
          aria-label={t('send.secret_label')} spellcheck={false} autoComplete="off" data-autofocus rows={1}
          placeholder={s.fields.length && !s.note ? t('send.note_placeholder') : t('send.placeholder')}
          onPaste={onPaste} onInput={(e) => set({ note: (e.target as HTMLTextAreaElement).value, detected: null })} />
      </div>
      {s.fields.length > 0 && (
        <div class="items">
          {s.fields.map((f, i) => (
            <div class="field edit" key={f.id}>
              <span class="k">
                <input value={f.k} placeholder={t('send.field_name')} aria-label={t('send.field_n_name', { n: i + 1 })} disabled={props.disabled} maxLength={80}
                  onInput={(e) => {
                    const k = (e.target as HTMLInputElement).value;
                    updateRow(f.id, { k, secret: f.secret || isSecretKey(k) });
                  }} />
                {f.generated && <span class="tag">{t('send.generated')}</span>}
              </span>
              <input class={`v${f.secret && !f.shown ? ' secret' : ''}`} type={f.secret && !f.shown ? 'password' : 'text'} value={f.v}
                placeholder={t('send.field_value')} aria-label={t('send.field_value_label', { name: f.k || t('send.field_n', { n: i + 1 }) })} disabled={props.disabled} autoComplete="off" spellcheck={false}
                onInput={(e) => updateRow(f.id, { v: (e.target as HTMLInputElement).value, generated: false })} />
              <span class="acts">
                {f.secret && (
                  <button type="button" class="btn icon sm ghost" aria-label={f.shown ? t('reveal.hide') : t('reveal.show')} title={f.shown ? t('reveal.hide') : t('reveal.show')}
                    onClick={() => updateRow(f.id, { shown: !f.shown })}><Icon name={f.shown ? 'eyeoff' : 'eye'} size="sm" /></button>
                )}
                {(isPasswordKey(f.k) || f.k === t('send.field_password')) && (
                  <button type="button" class="btn sm ghost" onClick={() => updateRow(f.id, { v: generatePassword(), generated: true, secret: true })}>{t('send.generate')}</button>
                )}
                <button type="button" class="btn icon sm ghost" aria-label={t('send.remove_field')} title={t('send.remove_field')} onClick={() => removeRow(f.id)}><Icon name="x" size="sm" /></button>
              </span>
            </div>
          ))}
        </div>
      )}
      {s.files.length > 0 && (
        <div class="files">
          {s.files.map((f, i) => (
            <span class="file" key={`${f.name}-${i}`}>
              <Icon name="file" size="sm" /><FileName name={f.name} /><small>{bytes(f.size)}</small>
              <button type="button" class="btn icon sm ghost" aria-label={t('send.remove_file_named', { name: f.name })} title={t('send.remove_file')} disabled={props.disabled}
                onClick={() => set({ files: s.files.filter((_, j) => j !== i) })}><Icon name="x" size="sm" /></button>
            </span>
          ))}
        </div>
      )}
      <div class="cmp-bar" ref={barRef}>
        <input ref={fileRef} type="file" multiple class="sr" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { addFiles(Array.from((e.target as HTMLInputElement).files ?? [])); (e.target as HTMLInputElement).value = ''; }} />
        {props.maxFiles > 0 && (
          <button type="button" class="btn sm ghost" disabled={props.disabled || s.files.length >= props.maxFiles} onClick={() => fileRef.current?.click()}>
            <Icon name="clip" size="sm" />{t('send.attach')}
          </button>
        )}
        <button type="button" class="btn sm ghost" disabled={props.disabled} onClick={() => {
          set({ fields: [...s.fields, newRow()] });
          // This composer's new row: the large editor and the page each have one.
          setTimeout(() => rootRef.current?.querySelector<HTMLInputElement>('.field.edit:last-child .k input')?.focus());
        }}><Icon name="plus" size="sm" />{t('send.add_field')}</button>
        {props.onExpand && (
          <button type="button" class="btn sm ghost cmp-expand" disabled={props.disabled} title={t('send.expand_title')} aria-label={t('send.expand_title')}
            aria-haspopup="dialog" onClick={props.onExpand}><Icon name="expand" size="sm" /><span class="cmp-expand-l">{t('send.expand')}</span></button>
        )}
        <span class="cmp-end">
        {s.detected ? (
          <span class="detected" role="status">
            <Icon name="scan" size="sm" />
            {s.detected.env ? t('send.detected_env') : t('send.detected', { count: s.detected.count })} · <button type="button" class="link" onClick={undo}>{t('send.undo')}</button>
          </span>
        ) : empty ? (
          <span class="detected drop-only">{t('send.drop_hint')}</span>
        ) : (
          <span class={`detected counter${over ? ' over' : ''}`}>
            {t('send.counter', { used: num(used), max: num(props.maxChars) })}{s.files.length > 0 && ` · ${t('send.counter_files', { files: s.files.length, maxFiles: props.maxFiles })}`}
          </span>
        )}
        <span class="sr" aria-live="polite">{near && focus && !s.detected ? t('send.counter', { used: num(used), max: num(props.maxChars) }) : ''}</span>
        {props.trailing}
        </span>
      </div>
      {props.overlay}
    </section>
  );
}
