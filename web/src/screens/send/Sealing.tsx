/** A4: encrypting and uploading, with per-file steps, time left and Cancel. */
import { useRef } from 'preact/hooks';
import { bytes, shortDuration } from '../../lib/format';
import { t } from '../../lib/i18n';
import { Icon } from '../../ui/icons';

export interface SealProgress {
  stream: number;
  done: number;
  total: number;
}

export function Sealing({ files, manifestBytes, progress, onCancel, cancelling, offline }: {
  files: File[]; manifestBytes: number; progress: SealProgress; onCancel: () => void; cancelling: boolean; offline: boolean;
}) {
  const started = useRef(Date.now());
  const pct = progress.total ? Math.min(100, Math.round((100 * progress.done) / progress.total)) : 0;
  const elapsed = (Date.now() - started.current) / 1000;
  const left = progress.done > 0 && elapsed > 2 ? ((progress.total - progress.done) * elapsed) / progress.done : null;
  // Steps: one per file (stream n), then "Create the link". The message itself (stream 0) is tiny.
  let offset = manifestBytes;
  const steps = files.map((f, i) => {
    const start = offset;
    offset += f.size;
    const doneHere = Math.max(0, Math.min(f.size, progress.done - start));
    const state = progress.stream > i + 1 || doneHere >= f.size ? 'done' : progress.stream === i + 1 ? 'now' : 'todo';
    return { f, state, doneHere };
  });
  const allUploaded = progress.done >= progress.total;
  return (
    <section class="card" aria-live="polite">
      <div class="card-b stack">
        <div class="between">
          <span class="h3">{t('send.encrypting')}</span>
          <span class="mono small muted">{files.length ? `${bytes(progress.done)} of ${bytes(progress.total)}` : `${pct}%`}</span>
        </div>
        <div class="progress" role="progressbar" aria-label={t('send.encrypting')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${pct}%` }} />
        </div>
        {files.length > 0 && (
          <div class="steps">
            {steps.map(({ f, state, doneHere }, i) => (
              <div class={`step ${state}`} key={i}>
                <span class="s">{state === 'done' ? <Icon name="check" /> : i + 1}</span>
                {state === 'now' ? <b>{t('send.encrypting_file', { name: f.name })}</b>
                  : <span>{state === 'done' ? t('send.encrypted_file', { name: f.name }) : t('send.encrypting_file', { name: f.name })}</span>}
                <span class="mono small muted">{state === 'now' ? `${bytes(doneHere)} / ${bytes(f.size)}` : bytes(f.size)}</span>
              </div>
            ))}
            <div class={`step ${allUploaded ? 'now' : 'todo'}`}>
              <span class="s">{files.length + 1}</span>{allUploaded ? <b>Create the link</b> : <span>Create the link</span>}<span />
            </div>
          </div>
        )}
        <p class="fine">{offline ? t('errors.offline') : t('send.keep_open')}</p>
      </div>
      <div class="card-f between">
        <span class="muted small">{left !== null && left > 3 ? `About ${shortDuration(left)} left` : ''}</span>
        <button type="button" class="btn secondary" onClick={onCancel} disabled={cancelling}>{t('send.cancel')}</button>
      </div>
    </section>
  );
}
