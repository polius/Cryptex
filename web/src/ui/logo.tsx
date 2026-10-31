/** The logo picker in setup and Server › Branding: drop or browse a square SVG or PNG, or remove it. With `onPick`
 *  (setup) the file stays in the browser for the page to send later; without it, it's saved on the server now. */
import { useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../api/client';
import { bytes } from '../lib/format';
import { rich, t } from '../lib/i18n';
import { toast } from '../lib/state';
import { errorText } from '../screens/errors';
import { ErrMsg } from './bits';
import { Mark } from './icons';

const LOGO_MAX = 1024 * 1024; // the server's limit too

export function LogoDrop({ logoUrl, logoName, disabled, onChange, onPick }: {
  logoUrl: string | null; logoName: string | null; disabled?: boolean; onChange?: () => void; onPick?: (f: File | null) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      onChange?.();
    } catch (e) {
      const big = e instanceof ApiError && (e.status === 413 || e.code === 'too_large'); // from the API or a proxy in front of it
      setErr(big ? t('branding.logo_size', { size: bytes(LOGO_MAX) }) : errorText(e));
    }
  };
  const upload = (f: File) => {
    if (!['image/svg+xml', 'image/png'].includes(f.type)) return setErr(t('branding.logo_type'));
    if (f.size > LOGO_MAX) return setErr(t('branding.logo_size', { size: bytes(LOGO_MAX) }));
    setErr(null);
    if (onPick) return onPick(f);
    return run(async () => {
      await api('PUT', '/server/branding/logo', { bytes: new Uint8Array(await f.arrayBuffer()), headers: { 'Content-Type': f.type, 'X-File-Name': f.name } });
      toast(t('branding.logo_updated'));
    });
  };
  return (
    <div>
      <div class="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f && !disabled) void upload(f); }}>
        {logoUrl ? <img class="op-logo img lg" src={logoUrl} alt={t('branding.logo_current')} /> : <span class="op-logo lg plain" aria-hidden="true"><Mark /></span>}
        <span class="small"><b>{logoUrl ? logoName ?? t('branding.logo_current') : t('branding.logo_none')}</b><br /><span class="muted">{rich('branding.logo_drop', { browse: <button type="button" class="link" disabled={disabled} onClick={() => fileRef.current?.click()}>{t('branding.browse')}</button> })}</span>
          {logoUrl && !disabled && <> · <button type="button" class="link" onClick={() => (onPick ? onPick(null) : void run(() => api('DELETE', '/server/branding/logo')))}>{t('branding.logo_remove')}</button></>}</span>
        <input ref={fileRef} type="file" accept="image/svg+xml,image/png" class="sr" tabIndex={-1} aria-hidden="true" onChange={(e) => { const i = e.target as HTMLInputElement; const f = i.files?.[0]; i.value = ''; if (f) void upload(f); }} />
      </div>
      {err && <ErrMsg>{err}</ErrMsg>}
    </div>
  );
}
