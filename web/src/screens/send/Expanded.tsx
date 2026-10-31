/** The large editor: the same composer, given room. Shares state with the page, so closing loses nothing. */
import type { ComponentProps } from 'preact';
import { t } from '../../lib/i18n';
import { Btn } from '../../ui/bits';
import { useFocusTrap } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Composer } from './Composer';

type ComposerProps = Omit<ComponentProps<typeof Composer>, 'expanded' | 'onExpand' | 'trailing' | 'registerPaste' | 'registerDrop'>;

export function ExpandedComposer({ open, onClose, ...composer }: ComposerProps & { open: boolean; onClose: () => void }) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return (
    <div class="scrim editor-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="editor" ref={ref} role="dialog" aria-modal="true" aria-labelledby="editor-title">
        <header class="editor-h">
          <h2 class="sr" id="editor-title">{t('send.title')}</h2>
          <span class="editor-sub"><Icon name="lock" size="sm" />{t('send.editor_sub')}</span>
          <span class="editor-close">
            <kbd aria-hidden="true">Esc</kbd>
            <button type="button" class="btn icon ghost" aria-label={t('send.collapse')} title={t('send.collapse')} onClick={onClose}>
              <Icon name="collapse" size="sm" />
            </button>
          </span>
        </header>
        <Composer {...composer} expanded registerPaste={() => undefined}
          trailing={<Btn kind="primary" class="sm editor-done" onClick={onClose}>{t('send.editor_done')}</Btn>} />
      </div>
    </div>
  );
}
