/** D4: the revealed secret (also used for request answers). Clears itself after 5 idle or hidden minutes. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Revealed } from '../../flows/reveal';
import { bytes } from '../../lib/format';
import { t } from '../../lib/i18n';
import { Banner, Btn, copyText } from '../../ui/bits';
import { Icon } from '../../ui/icons';

const IDLE = 5 * 60;

function envName(k: string): string {
  const n = k.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return /^[0-9]/.test(n) ? `_${n}` : n || 'VALUE';
}

export function toEnv(items: Revealed['items']): string {
  return items.filter((i) => i.t === 'field').map((i) => {
    const f = i as { k: string; v: string };
    const v = /^[A-Za-z0-9_./:@-]*$/.test(f.v) ? f.v : `"${f.v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
    return `${envName(f.k)}=${v}`;
  }).join('\n') + '\n';
}

function save(blob: Blob, name: string, urls: string[]) {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[/\\]/g, '_') || 'file';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function Output({ data, title, from, deletedNote, onCleared }: {
  data: Revealed; title: string; from: string | null; deletedNote: string; onCleared: () => void;
}) {
  const [left, setLeft] = useState(IDLE);
  const [shown, setShown] = useState<Set<number>>(new Set());
  const [zipping, setZipping] = useState(false);
  const urls = useRef<string[]>([]);
  const last = useRef(Date.now());
  const hiddenAt = useRef<number | null>(null);

  const clear = () => {
    urls.current.forEach((u) => URL.revokeObjectURL(u));
    urls.current = [];
    // Wipe decrypted values from memory and the DOM.
    data.items.length = 0;
    data.files.length = 0;
    onCleared();
  };

  useEffect(() => {
    const bump = () => {
      last.current = Date.now();
    };
    const vis = () => {
      if (document.hidden) hiddenAt.current = Date.now();
      else {
        if (hiddenAt.current && Date.now() - hiddenAt.current >= IDLE * 1000) clear();
        hiddenAt.current = null;
        bump();
      }
    };
    const id = setInterval(() => {
      const idle = (Date.now() - last.current) / 1000;
      const remaining = Math.max(0, Math.ceil(IDLE - idle));
      setLeft(remaining);
      if (remaining === 0) clear();
    }, 1000);
    for (const ev of ['pointerdown', 'keydown', 'scroll', 'pointermove']) window.addEventListener(ev, bump, { passive: true });
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(id);
      for (const ev of ['pointerdown', 'keydown', 'scroll', 'pointermove']) window.removeEventListener(ev, bump);
      document.removeEventListener('visibilitychange', vis);
      urls.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const fields = data.items.filter((i) => i.t === 'field');
  const zipAll = async () => {
    setZipping(true);
    try {
      const { zipSync } = await import('fflate');
      const entries: Record<string, Uint8Array> = {};
      for (const f of data.files) {
        let name = f.name.replace(/[/\\]/g, '_');
        while (entries[name]) name = `copy-${name}`;
        entries[name] = new Uint8Array(await f.blob.arrayBuffer());
      }
      save(new Blob([zipSync(entries, { level: 0 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), `${(title || 'secret').replace(/[^\w .-]+/g, '_')}.zip`, urls.current);
    } finally {
      setZipping(false);
    }
  };

  return (
    <>
      <Banner kind="ok" icon="check" action={<span class="timer" aria-live="off">{t('reveal.clears_in', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}</span>}>
        {deletedNote}
      </Banner>
      <section class="out reveal-in" aria-label="Secret">
        <div class="out-h"><span class="h3">{title || 'Secret'}</span>{from && <span class="muted small">from {from}</span>}</div>
        {data.items.map((it, i) => it.t === 'note' ? (
          <div class="note out-note" key={i}>
            <pre>{it.v}</pre>
            <span class="acts"><button class="btn icon sm ghost" aria-label={t('reveal.copy')} title={t('reveal.copy')} onClick={() => copyText(it.v)}><Icon name="copy" size="sm" /></button></span>
          </div>
        ) : (
          <div class="field" key={i}>
            <span class="k">{it.k}</span>
            <span class={`v${it.secret && !shown.has(i) ? ' secret' : ''}`}>{it.secret && !shown.has(i) ? '•'.repeat(Math.min(16, Math.max(8, it.v.length))) : it.v}</span>
            <span class="acts">
              {it.secret && (
                <button class="btn icon sm ghost" aria-label={shown.has(i) ? t('reveal.hide') : t('reveal.show')} title={shown.has(i) ? t('reveal.hide') : t('reveal.show')}
                  onClick={() => setShown((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>
                  <Icon name={shown.has(i) ? 'eyeoff' : 'eye'} size="sm" />
                </button>
              )}
              <button class="btn icon sm ghost" aria-label={`${t('reveal.copy')} ${it.k}`} title={t('reveal.copy')} onClick={() => copyText(it.v)}><Icon name="copy" size="sm" /></button>
            </span>
          </div>
        ))}
        {data.files.map((f, i) => (
          <div class="field" key={`f${i}`}>
            <span class="k">File</span>
            <span class="v">{f.name} <small class="muted mono">{bytes(f.size)}</small></span>
            <span class="acts"><Btn kind="secondary" class="sm" icon="down" onClick={() => save(f.blob, f.name, urls.current)}>{t('reveal.save')}</Btn></span>
          </div>
        ))}
      </section>
      <div class="actions-m between">
        <div class="row">
          {fields.length > 0 && <Btn kind="secondary" icon="copy" onClick={() => copyText(toEnv(data.items), 'Copied as .env')}>{t('reveal.copy_env')}</Btn>}
          {data.files.length > 1 && <Btn kind="secondary" icon="down" loading={zipping} onClick={zipAll}>{t('reveal.zip')}</Btn>}
        </div>
        <button class="btn ghost" onClick={clear}>{t('reveal.clear_now')}</button>
      </div>
      <p class="fine">{t('reveal.clipboard_note')}</p>
    </>
  );
}
