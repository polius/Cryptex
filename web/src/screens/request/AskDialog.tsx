/** Ask for a secret: a note and how long, then the request link's "ready" page (its /r/:id, screens/links/Receipt.tsx).
 *  Whoever opens the link sends a secret that's encrypted for you alone (flows/request.ts); it shows in Your links. */
import { useEffect, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { createRequest, justAsked, NOTE_MAX } from '../../flows/request';
import { t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { cfg, countLinks, loadConfig } from '../../lib/state';
import { Btn, Choices, ErrMsg } from '../../ui/bits';
import { Dialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { errorText } from '../errors';
import { CUSTOM, CustomExpiry, expiryOptions } from '../send/Policy';

export function AskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const c = cfg();
  const options = [...expiryOptions(c.limits.max_expires_in, c.demo), { value: CUSTOM, label: t('policy.custom'), disabled: c.demo ? t('policy.not_in_demo') : undefined }];
  const [expiresIn, setExpiresIn] = useState(() => Math.min(c.defaults.expires_in, c.limits.max_expires_in));
  // Custom: any time up to the server's longest, as on the send form. `picked` focuses its number only when chosen.
  const [custom, setCustom] = useState(false);
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Each opening starts afresh. Cleared on closing, so nothing typed as it opens is lost.
  useEffect(() => {
    if (!open) {
      setErr(null);
      setNote('');
    }
  }, [open]);

  async function create() {
    setErr(null);
    setBusy(true);
    try {
      const item = await createRequest(c, expiresIn, note);
      let copied = false;
      try {
        await navigator.clipboard.writeText(item.link!); // right away: browsers only allow it shortly after the click
        copied = true;
      } catch {
        /* copied with the button */
      }
      countLinks();
      if (c.demo) void loadConfig().catch(() => undefined); // today's demo quota
      justAsked.value = { item, copied };
      onClose();
      navigate(`/r/${item.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'rate_limited' && c.demo && e.reason === 'demo_day') {
        onClose();
        navigate('/demo/limit');
        return;
      }
      setErr((e as Error)?.message === 'locked' ? t('ask.unlock') : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} labelledBy="ask-title" wide
      footer={<>
        <button type="button" class="btn secondary" onClick={onClose}>{t('send.cancel')}</button>
        <Btn kind="primary" icon="link" loading={busy} onClick={() => void create()}>{t('ask.create')}</Btn>
      </>}>
      <div class="stack ask-dialog">
        <h2 class="h3" id="ask-title">{t('ask.title')}</h2>
        <p class="muted">{t('ask.lede')}</p>
        <div>
          <label class="label" for="ask-note">{t('ask.note')}<span class="opt-tag">{t('common.optional')}</span></label>
          <textarea id="ask-note" class="input textarea" rows={3} maxLength={NOTE_MAX} value={note} readOnly={busy} data-autofocus
            aria-describedby="ask-note-help" onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
          <p class="help" id="ask-note-help">{t('ask.note_help')}</p>
        </div>
        <div class="stack" style="gap:8px">
          <span class="label" id="ask-exp">{t('policy.expires_after')}</span>
          <Choices label={t('policy.expires_after')} value={custom ? CUSTOM : expiresIn} options={options} locked={busy}
            onChange={(v) => { setPicked(true); setCustom(v === CUSTOM); if (v !== CUSTOM) setExpiresIn(v); }} />
          {custom && <CustomExpiry value={expiresIn} max={c.limits.max_expires_in} focus={picked} onChange={setExpiresIn} />}
          <p class="help">{t('ask.expires_help')}</p>
          {c.demo && <p class="fine ask-local"><Icon name="info" size="sm" />{t('policy.demo_note')}</p>}
        </div>
        {!c.signed_in && <p class="fine ask-local"><Icon name="info" size="sm" />{t('ask.local_note')}</p>}
        {err && <ErrMsg>{err}</ErrMsg>}
      </div>
    </Dialog>
  );
}
