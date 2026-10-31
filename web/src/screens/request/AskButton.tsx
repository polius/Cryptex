/** "Ask for a secret", beside a page's heading (the send page, Your links): opens the dialog that makes a request
 *  link. Whoever may create links may ask. On phones only its icon shows, inside `.page-acts`. */
import type { ComponentType } from 'preact';
import { useState } from 'preact/hooks';
import { t } from '../../lib/i18n';
import { config } from '../../lib/state';
import { Btn } from '../../ui/bits';
import type { AskDialog as Dlg } from './AskDialog';

export function AskButton() {
  const c = config.value;
  const [open, setOpen] = useState(false);
  const [Dialog, setDialog] = useState<ComponentType<Parameters<typeof Dlg>[0]> | null>(null);
  if (!c || !(c.signed_in || c.mode === 'anyone' || c.demo)) return null;
  const show = async () => {
    if (!Dialog) {
      const m = await import('./AskDialog'); // the dialog and its crypto load on first use: the send page stays light
      setDialog(() => m.AskDialog);
    }
    setOpen(true);
  };
  return (
    <>
      <Btn kind="secondary" icon="inbox" label={t('ask.title')} onClick={() => void show()}><span class="ask-l">{t('ask.title')}</span></Btn>
      {Dialog && <Dialog open={open} onClose={() => setOpen(false)} />}
    </>
  );
}
