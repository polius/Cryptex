/** Modal dialog / bottom sheet: traps focus, closes on Esc and returns focus to the opener (frontend.md §6). */
import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

export function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
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
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [open]);
  return ref;
}

export function Dialog(props: {
  open: boolean; onClose: () => void; labelledBy: string; alert?: boolean; children: ComponentChildren; footer?: ComponentChildren;
}): JSX.Element | null {
  const ref = useFocusTrap(props.open, props.onClose);
  if (!props.open) return null;
  return (
    <div class="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dialog" ref={ref} role={props.alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={props.labelledBy}>
        <div class="dialog-b">{props.children}</div>
        {props.footer && <div class="dialog-f">{props.footer}</div>}
      </div>
    </div>
  );
}
