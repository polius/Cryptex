/** Small shared components from the component sheet (design/v3/proto/components.html). */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../lib/i18n';
import { toast } from '../lib/state';
import { Icon, type IconName } from './icons';

export function Status({ kind, children }: { kind: 'waiting' | 'opened' | 'expired' | 'answer' | 'destroyed' | 'danger' | 'warn'; children: ComponentChildren }) {
  return <span class={`status ${kind}`}><i aria-hidden="true" />{children}</span>;
}

export function Spinner() {
  return <span class="spin" aria-hidden="true" />;
}

/** Button with the loading state from frontend.md §7: the spinner replaces the icon, the label stays. */
export function Btn(props: {
  kind?: string; icon?: IconName; loading?: boolean; disabled?: boolean; onClick?: (e: MouseEvent) => void; type?: 'button' | 'submit';
  children?: ComponentChildren; label?: string; title?: string; class?: string; href?: string; id?: string;
}): JSX.Element {
  const cls = `btn ${props.kind ?? 'secondary'} ${props.class ?? ''}`.trim();
  const inner = <>{props.loading ? <Spinner /> : props.icon && <Icon name={props.icon} size="sm" />}{props.children}</>;
  if (props.href) return <a class={cls} href={props.href} id={props.id} aria-label={props.label} title={props.title}>{inner}</a>;
  return (
    <button type={props.type ?? 'button'} class={cls} disabled={props.disabled || props.loading} aria-busy={props.loading || undefined}
      onClick={props.onClick} aria-label={props.label} title={props.title ?? props.label} id={props.id}>
      {inner}
    </button>
  );
}

export function Switch({ on, onChange, label, disabled, id }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} id={id} class={`switch${on ? ' on' : ''}`} disabled={disabled}
      onClick={() => onChange(!on)} />
  );
}

export function Choices<T extends string | number>(props: {
  value: T; options: Array<{ value: T; label: string; disabled?: string }>; onChange: (v: T) => void; label: string; locked?: boolean;
}) {
  return (
    <div class="choices" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button type="button" role="radio" aria-checked={o.value === props.value} key={String(o.value)}
          class={`choice${o.value === props.value ? ' on' : ''}${o.disabled ? ' off' : ''}`}
          disabled={!!o.disabled || props.locked} title={o.disabled} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Radio(props: {
  on: boolean; onSelect: () => void; title: string; help?: string; disabled?: string; children?: ComponentChildren; name: string;
}) {
  return (
    <label class={`radio${props.on ? ' on' : ''}${props.disabled ? ' off' : ''}`} title={props.disabled}>
      <input type="radio" class="sr" name={props.name} checked={props.on} disabled={!!props.disabled} onChange={props.onSelect} />
      <span class="o" aria-hidden="true" />
      <b>{props.title}</b>
      {(props.disabled || props.help) && <small>{props.disabled || props.help}</small>}
      {props.on && props.children && <div class="in">{props.children}</div>}
    </label>
  );
}

/** Copy inside the click handler; on failure, select the text and say how (frontend.md §9). */
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
    toast(navigator.platform.includes('Mac') ? 'Press ⌘C to copy' : 'Press Ctrl+C to copy', 'info');
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

export function Banner({ kind, icon, children, action }: { kind: 'ok' | 'warn' | 'danger' | 'info'; icon: IconName; children: ComponentChildren; action?: ComponentChildren }) {
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

/** Page heading that takes the first focus on each route (frontend.md §6). */
export function H1({ children, class: cls = 'h1' }: { children: ComponentChildren; class?: string }) {
  return <h1 class={cls} tabIndex={-1} data-page-heading>{children}</h1>;
}
