/** Told at sign-in when an owner made a reset link for this account, so a link nobody asked for doesn't go unseen.
 *  "Cancel the link" stops it; "I asked for it" just dismisses. Closing it otherwise only hides it in this tab. */
import { useState } from 'preact/hooks';
import { api } from '../api/client';
import { dateTime } from '../lib/format';
import { rich, t } from '../lib/i18n';
import { config, loadConfig, toast } from '../lib/state';
import { errorText } from '../screens/errors';
import { Btn, ErrMsg } from './bits';
import { Dialog } from './dialog';

export function ResetNotice() {
  const n = config.value?.user?.notice;
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<'cancel' | 'ok' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!n || hidden) return null;
  const act = async (kind: 'cancel' | 'ok') => {
    setBusy(kind);
    setErr(null);
    try {
      await api('DELETE', kind === 'cancel' ? '/me/reset-link' : '/me/notice');
      if (kind === 'cancel') toast(t('notice.cancelled'));
      await loadConfig();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open onClose={() => setHidden(true)} labelledBy="rn-title" footer={<>
      {n.pending && <Btn kind="secondary" class="danger" loading={busy === 'cancel'} onClick={() => act('cancel')}>{t('notice.cancel')}</Btn>}
      <Btn kind="primary" loading={busy === 'ok'} onClick={() => act('ok')}>{n.pending ? t('notice.ok') : t('send.done')}</Btn></>}>
      <h2 class="h3" id="rn-title">{t('notice.title')}</h2>
      <p>{rich('notice.body', { by: <b>{n.by}</b>, date: dateTime(n.at) })}</p>
      <p class="muted small">{n.pending ? t('notice.ask_pending') : t('notice.ask_done')}</p>
      {err && <ErrMsg>{err}</ErrMsg>}
    </Dialog>
  );
}
