/** Modal dialog / bottom sheet: traps focus, closes on Esc and returns focus to the opener.
 *  Dialogs stack (re-auth over Add person, a confirmation over a prompt): only the topmost one answers Esc and Tab. */
import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
/** Open dialogs, bottom first: each one's token and its panel. */
const stack: Array<{ token: object; el: HTMLElement | null }> = [];

const usable = (x: HTMLElement | null | undefined): x is HTMLElement =>
  !!x && x.isConnected && !x.matches(':disabled') && x.offsetParent !== null;

/** Focus the first usable candidate; true if one took it. */
function focusFirst(candidates: Array<HTMLElement | null | undefined>): boolean {
  for (const x of candidates) {
    if (!usable(x)) continue;
    x.focus();
    if (document.activeElement === x) return true;
  }
  return false;
}

/** Where focus goes back to when a dialog closes, if not the element focused as it opened: the button that started
 *  it, captured before the request that opens it (a busy button is disabled, and focus falls to the page), or an
 *  element looked up at close time (the composer after a prompt over the send page). */
export type ReturnTo = HTMLElement | null | (() => HTMLElement | null);

/** Where focus goes back to. An item inside a menu unmounts with the menu, so it's the menu's button instead.
 *  When a dialog closes over another one (re-auth over Add person), focus must stay inside the one below: if the
 *  opener is gone, or disabled (a button busy with the request that opened this dialog), that dialog's first control.
 *  Otherwise the page heading. */
function returnTarget(to: ReturnTo): () => void {
  const menuButton = (x: HTMLElement | null) => x?.closest('.has-pop')?.querySelector<HTMLElement>('[aria-haspopup],[aria-expanded]') ?? null;
  const early = typeof to === 'function' ? null : menuButton(to); // a menu item is gone by the time the dialog closes
  return () => {
    const opener = typeof to === 'function' ? to() : to;
    const trigger = typeof to === 'function' ? menuButton(opener) : early;
    const below = stack[stack.length - 1]?.el;
    if (below?.isConnected) {
      const inside = [opener, trigger].filter((x) => x && below.contains(x));
      if (!focusFirst([...inside, below.querySelector<HTMLElement>('[data-autofocus]'), ...Array.from(below.querySelectorAll<HTMLElement>(FOCUSABLE))])) {
        below.setAttribute('tabindex', '-1');
        below.focus();
      }
      return;
    }
    if (!focusFirst([opener, trigger])) document.querySelector<HTMLElement>('[data-page-heading]')?.focus();
  };
}

export function useFocusTrap(open: boolean, onClose: () => void, returnTo?: ReturnTo) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const token = {};
    const el = ref.current;
    const back = returnTarget(returnTo ?? (document.activeElement as HTMLElement | null));
    stack.push({ token, el });
    // The latest dialog shows on top, whichever order the page renders them in (re-auth over a vault prompt).
    const scrim = el?.parentElement?.classList.contains('scrim') ? el.parentElement : null;
    if (scrim) scrim.style.zIndex = String(30 + stack.length);
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    // A modal keeps focus: a screen behind it that finishes loading, or changes step, can't take it away.
    const modal = el?.getAttribute('aria-modal') === 'true';
    const onFocusIn = (e: FocusEvent) => {
      if (!modal || !el || stack[stack.length - 1]?.token !== token || el.contains(e.target as Node)) return;
      (el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    };
    document.addEventListener('focusin', onFocusIn);
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1]?.token !== token) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab' && el) {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const [a, b] = [items[0], items[items.length - 1]];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      stack.splice(stack.findIndex((x) => x.token === token), 1);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      document.body.style.overflow = overflow;
      // Back to the opener once the page settles (the opener may re-render, or be replaced, in the same update).
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected) back();
      });
    };
  }, [open]);
  return ref;
}

export function Dialog(props: {
  open: boolean; onClose: () => void; labelledBy: string; alert?: boolean; children: ComponentChildren; footer?: ComponentChildren;
  /** Room for a whole link on one line. */
  wide?: boolean;
  /** Focus goes back here on close instead of to the element focused as the dialog opened. */
  returnTo?: ReturnTo;
}): JSX.Element | null {
  const ref = useFocusTrap(props.open, props.onClose, props.returnTo);
  if (!props.open) return null;
  return (
    <div class="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class={`dialog${props.wide ? ' wide' : ''}`} ref={ref} role={props.alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={props.labelledBy}>
        <div class="dialog-b">{props.children}</div>
        {props.footer && <div class="dialog-f">{props.footer}</div>}
      </div>
    </div>
  );
}
