/** Authenticator setup in two steps: add the key to an app, then enter the first code.
 *  On a computer the QR code leads, with the key beside it. On a phone or tablet the QR can't be scanned by the
 *  same device, so a button opens the authenticator app directly (otpauth://), the key comes next, and the QR is
 *  folded away for scanning with another device. Used by setup, invites, reset links and Your account. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n';
import { Btn, copyText, ErrMsg } from './bits';
import { Icon } from './icons';

export interface TotpSetup { secret: string; uri: string }

const handheld = () => typeof document !== 'undefined' && document.documentElement.classList.contains('touch-os');

export function TotpEnroll({ setup, code, onCode, error, onEnter }: {
  setup: TotpSetup; code: string; onCode: (v: string) => void; error?: string | null; onEnter?: () => void;
}) {
  const [QR, setQR] = useState<null | ((p: { text: string; label: string }) => preact.JSX.Element)>(null);
  useEffect(() => { void import('./qr').then((m) => setQR(() => m.QR)); }, []);
  const keyRef = useRef<HTMLElement>(null);
  const groups = setup.secret.match(/.{1,4}/g) ?? [];
  const qr = <div class="qrbox">{QR && <QR text={setup.uri} label={t('totp.qr_label')} />}</div>;
  const key = (label: string) => (
    <div class="totp-key">
      <small>{label}</small>
      <code class="key mono" ref={keyRef} aria-label={t('totp.key_label')}>{groups.map((g, i) => <span key={i}>{g}</span>)}</code>
      <Btn kind="secondary" class="sm" icon="copy" onClick={() => void copyText(setup.secret, t('totp.key_copied'), keyRef.current)}>{t('totp.copy_key')}</Btn>
    </div>
  );
  return (
    <ol class="totp-steps">
      <li>
        <span class="n" aria-hidden="true">1</span>
        {handheld() ? (
          <div class="totp-step">
            <b>{t('totp.step_add')}</b>
            <small>{t('totp.apps')}</small>
            <a class="btn secondary lg totp-open" href={setup.uri}><Icon name="key" size="sm" />{t('totp.open_app')}</a>
            {key(t('totp.or_copy'))}
            <details class="totp-more"><summary>{t('totp.show_qr')}</summary>{qr}</details>
          </div>
        ) : (
          <div class="totp-step">
            <b>{t('totp.step_scan')}</b>
            <small>{t('totp.apps')}</small>
            <div class="totp-scan">{qr}{key(t('totp.or_key'))}</div>
          </div>
        )}
      </li>
      <li>
        <span class="n" aria-hidden="true">2</span>
        <div class="totp-step">
          <label for="totp-code"><b>{t('totp.step_code')}</b></label>
          <input id="totp-code" class={`input code${error ? ' err' : ''}`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} aria-invalid={!!error}
            aria-describedby={error ? 'totp-code-err' : undefined}
            placeholder="••••••" onInput={(e) => onCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && onEnter?.()} />
          {error && <ErrMsg id="totp-code-err">{error}</ErrMsg>}
        </div>
      </li>
    </ol>
  );
}
