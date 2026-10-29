/** Small shared components. */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n';
import { toast } from '../lib/state';
import { Icon, type IconName } from './icons';

export function Status({ kind, children }: { kind: 'waiting' | 'opened' | 'expired' | 'destroyed' | 'danger' | 'warn'; children: ComponentChildren }) {
  return <span class={`status ${kind}`}><i aria-hidden="true" />{children}</span>;
}

export function Spinner() {
  return <span class="spin" aria-hidden="true" />;
}

/** Button with a loading state: the spinner replaces the icon, the label stays. */
export function Btn(props: {
  kind?: string; icon?: IconName; loading?: boolean; disabled?: boolean; onClick?: (e: MouseEvent) => void; type?: 'button' | 'submit';
  children?: ComponentChildren; label?: string; title?: string; class?: string; href?: string; id?: string;
  /** The form a submit button outside it submits (a dialog's footer button): one button, Enter works in every field. */
  form?: string;
  /** Looks unavailable but stays focusable, so its title still explains why. */
  unavailable?: boolean;
}): JSX.Element {
  const cls = `btn ${props.kind ?? 'secondary'} ${props.class ?? ''}`.trim();
  const inner = <>{props.loading ? <Spinner /> : props.icon && <Icon name={props.icon} size="sm" />}{props.children}</>;
  if (props.href) return <a class={cls} href={props.href} id={props.id} aria-label={props.label} title={props.title}>{inner}</a>;
  return (
    <button type={props.type ?? 'button'} class={cls} disabled={props.disabled || props.loading} aria-busy={props.loading || undefined}
      onClick={props.onClick} aria-label={props.label} title={props.title ?? props.label} id={props.id} form={props.form} aria-disabled={props.unavailable || undefined}>
      {inner}
    </button>
  );
}

/** Arrow keys, Home and End in a radio group or tab list (WAI-ARIA): focus the next item and select it.
 *  The items use a roving tabindex: only the selected one is in the Tab order. An item that isn't available
 *  (aria-disabled) still takes focus, so its reason is read out, but it isn't selected. */
export function arrowSelect(e: KeyboardEvent): void {
  const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (!(e.key in step) && e.key !== 'Home' && e.key !== 'End') return;
  const items = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role=radio],[role=tab]'))
    .filter((x) => !x.hasAttribute('disabled'));
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (Math.max(0, i) + step[e.key] + items.length) % items.length;
  items[next].focus();
  if (items[next].getAttribute('aria-disabled') !== 'true') items[next].click();
}

/** A row of choices. One that isn't available keeps its place in the arrow-key order (aria-disabled, not disabled),
 *  so keyboard and screen-reader users hear why: the reason is its description. */
export function Choices<T extends string | number>(props: {
  value: T; options: Array<{ value: T; label: string; disabled?: string }>; onChange: (v: T) => void; label: string; locked?: boolean;
}) {
  const id = useId();
  const current = props.options.some((o) => o.value === props.value) ? props.value : props.options[0]?.value;
  return (
    <div class="choices" role="radiogroup" aria-label={props.label} onKeyDown={arrowSelect}>
      {props.options.map((o, i) => (
        <button type="button" role="radio" aria-checked={o.value === props.value} key={String(o.value)}
          class={`choice${o.value === props.value ? ' on' : ''}${o.disabled ? ' off' : ''}`} tabIndex={o.value === current ? 0 : -1}
          disabled={props.locked} aria-disabled={o.disabled ? true : undefined} aria-describedby={o.disabled ? `${id}-${i}` : undefined}
          title={o.disabled} onClick={() => !o.disabled && props.onChange(o.value)}>
          {o.label}{o.disabled && <span hidden id={`${id}-${i}`}>{o.disabled}</span>}
        </button>
      ))}
    </div>
  );
}

/** `disabled` is the reason it can't be chosen; a blank one (" ") disables it without a reason, and the help stays.
 *  Like Choices, an unavailable option stays in the keyboard order (aria-disabled) so its description is heard;
 *  cancelling the click keeps it from being checked, by mouse or by the arrow keys. */
export function Radio(props: {
  on: boolean; onSelect: () => void; title: string; help?: string; disabled?: string; children?: ComponentChildren; name: string;
}) {
  const id = useId();
  const note = props.disabled?.trim() || props.help;
  return (
    <label class={`radio${props.on ? ' on' : ''}${props.disabled ? ' off' : ''}`} title={props.disabled?.trim() || undefined}>
      <input type="radio" class="sr" name={props.name} checked={props.on} aria-disabled={props.disabled ? true : undefined}
        onClick={(e) => props.disabled && e.preventDefault()} onChange={() => !props.disabled && props.onSelect()}
        aria-describedby={note ? id : undefined} />
      <span class="o" aria-hidden="true" />
      <b>{props.title}</b>
      {note && <small id={id}>{note}</small>}
      {props.on && props.children && <div class="in">{props.children}</div>}
    </label>
  );
}

/** "This is a shared computer" (sign in, invite links, reset links, setup): the session ends with the browser, and
 *  nothing (no vault key, no links) is kept on this device. The server keeps the choice with the session. */
export function SharedCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <label class="check"><input type="checkbox" checked={checked} aria-describedby={id} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span><b>{t('signin.shared')}</b><small id={id}>{t('signin.shared_help')}</small></span></label>
  );
}

/** Copy inside the click handler; on failure, select the text and say how. */
export async function copyText(text: string, okMessage = t('toast.copied'), selectEl?: HTMLElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
    return true;
  } catch {
    if (selectEl) {
      const r = document.createRange();
      r.selectNodeContents(selectEl);
      const s = getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    }
    toast(t('toast.press_to_copy', { keys: navigator.platform.includes('Mac') ? '⌘C' : 'Ctrl+C' }), 'info');
    return false;
  }
}

/** Re-render every `ms` (relative times, countdowns). */
export function useTick(ms = 30_000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

export function Banner({ kind, icon, children, action }: { kind: 'ok' | 'warn' | 'danger' | 'info' | 'demo'; icon: IconName; children: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class={`banner ${kind}`} role={kind === 'danger' ? 'alert' : undefined}>
      <Icon name={icon} />
      <span>{children}</span>
      {action && <><span class="sp" />{action}</>}
    </div>
  );
}

export function ErrMsg({ children, id }: { children: ComponentChildren; id?: string }) {
  return <p class="err-msg" id={id} role="alert"><Icon name="alert" size="sm" />{children}</p>;
}

/** Page heading that takes the first focus on each route. */
export function H1({ children, class: cls = 'h1' }: { children: ComponentChildren; class?: string }) {
  return <h1 class={cls} tabIndex={-1} data-page-heading>{children}</h1>;
}

/** Focus for content that changes in place, on the same route. `view` names what's on screen, or
 *  is null while it loads. Content arriving after a load gets the route's first focus: its heading. One view or step
 *  replacing another moves focus to the new one's first field ([data-autofocus]), or else its heading. Focus the
 *  person moved out of the page (to the header, a dialog) stays where it is. */
export function useViewFocus(view: string | number | null): void {
  const prev = useRef(view);
  useEffect(() => {
    const was = prev.current;
    prev.current = view;
    if (view === null || view === was) return;
    requestAnimationFrame(() => {
      const main = document.getElementById('main');
      const active = document.activeElement;
      if (!main || (active && active !== document.body && (!main.contains(active) || active.closest('[role=dialog],[role=alertdialog]')))) return;
      ((was !== null && main.querySelector<HTMLElement>('[data-autofocus]')) || main.querySelector<HTMLElement>('[data-page-heading]'))?.focus();
    });
  }, [view]);
}

/** End-of-flow card (for example, cleared): one icon, one heading, what happened, what to do next. */
export function Outcome({ icon, tone = 'ok', title, children, actions }: {
  icon: IconName; tone?: 'ok' | 'warn' | 'info'; title: ComponentChildren; children?: ComponentChildren; actions?: ComponentChildren;
}) {
  return (
    <section class="outcome" aria-labelledby="outcome-title">
      <div class="outcome-top tint" aria-hidden="true"><span class={`outcome-icon ${tone}`}><Icon name={icon} size="lg" /></span></div>
      <div class="outcome-body">
        <h1 class="h2" id="outcome-title" tabIndex={-1} data-page-heading>{title}</h1>
        {children && <div class="outcome-text">{children}</div>}
        {actions && <div class="outcome-actions">{actions}</div>}
      </div>
    </section>
  );
}

/** A shell command to run on the server, with a copy button. It wraps between words only, and the prompt sign is
 *  decoration: it isn't copied. `skipTab` keeps the button out of the Tab order, so Tab moves from the field
 *  above straight to the next one (the command text can still be selected and copied by hand). */
export function Command({ text, skipTab }: { text: string; skipTab?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  return (
    <div class="cmd">
      <code class="mono" ref={ref}>{text.split(' ').map((w, i) => <>{i > 0 && ' '}<span>{w}</span></>)}</code>
      <button type="button" class="btn ghost icon sm" aria-label={t('setup.copy_command')} title={t('setup.copy_command')} tabIndex={skipTab ? -1 : undefined}
        onClick={() => void copyText(text, t('toast.copied'), ref.current)}><Icon name="copy" size="sm" /></button>
    </div>
  );
}

/** A password field with Show/Hide, wherever someone types a password (setup, sign-in, invites, resets, re-auth,
 *  unlock, change password). `invalid` marks it as the field an error is about. */
export function PasswordInput({ invalid, ...props }: Omit<JSX.IntrinsicElements['input'], 'type' | 'class'> & { invalid?: boolean }) {
  const [shown, setShown] = useState(false);
  const label = shown ? t('reveal.hide') : t('reveal.show');
  return (
    <div class={`input${invalid ? ' err' : ''}`}>
      <input {...props} class="bare" type={shown ? 'text' : 'password'} spellcheck={false} autoCapitalize="none" autoCorrect="off" />
      <button type="button" class="btn icon sm ghost" aria-label={label} title={label} aria-pressed={shown} onClick={() => setShown(!shown)}>
        <Icon name={shown ? 'eyeoff' : 'eye'} size="sm" /></button>
    </div>
  );
}
