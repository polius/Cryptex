/** D4: the revealed secret. Clears itself after 5 idle or hidden minutes, with a warning in the last minute. Any
 *  input, focus move, scroll or return to the tab counts as activity (screen readers in browse mode move focus). */
import { useEffect, useRef, useState } from 'preact/hooks';
import { CHUNK } from '../../crypto/format';
import { safeFileName, type Revealed } from '../../flows/reveal';
import { bytes } from '../../lib/format';
import { t } from '../../lib/i18n';
import { Banner, Btn, copyText } from '../../ui/bits';
import { Icon } from '../../ui/icons';

const IDLE = 5 * 60;
const WARN = 60; // seconds left when the warning shows
const ACTIVITY = ['pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart', 'focusin'] as const;

/** Names that make a shell (bash, zsh) or the programs it starts do more than hold a value: prompts and their hooks
 *  (PROMPT_COMMAND runs, PS0–PS4 and zsh's PROMPT and SPROMPT are expanded at every prompt), files sourced or loaded
 *  at startup, where commands and libraries are looked up, word splitting, shell options, history, mail checks, the
 *  command run for a bare redirection (NULLCMD), the editor, pager or browser other tools run (git, gh, man, sudo,
 *  kubectl, systemctl), interpreter and package-manager options (NODE_OPTIONS, JAVA_TOOL_OPTIONS, npm's config),
 *  proxies, and TLS checks and trust. Field names are the sender's, so these get a leading _. This is best effort: no
 *  list can know every program's variables, so a .env from someone else is still worth a look before sourcing it. */
const SHELL_NAMES = new RegExp('^(?:' + [
  'PS[0-9]', 'PROMPT.*', 'RPROMPT.*', 'SPROMPT', 'RPS[0-9]', 'BASH.*', 'ENV', 'ZDOTDIR', 'FPATH', 'PATH', 'CDPATH', 'MANPATH', 'IFS',
  'SHELLOPTS', 'GLOBIGNORE', 'FIGNORE', 'EXECIGNORE', 'POSIXLY_CORRECT', 'HIST.*', 'MAIL.*', 'TMOUT', 'IGNOREEOF', 'HOME', 'PWD',
  'OLDPWD', 'SHELL', 'SHLVL', 'TERM', 'TERMINFO', 'INPUTRC', 'COMP.*', 'FCEDIT', 'NULLCMD', 'READNULLCMD',
  'EDITOR', 'VISUAL', 'PAGER', 'MANPAGER', 'BROWSER', 'LESS.*', 'SUDO_EDITOR', 'KUBE_EDITOR', 'SYSTEMD_EDITOR', 'SYSTEMD_PAGER.*',
  'GH_PAGER', 'GH_EDITOR', 'GH_BROWSER', 'LD_.*', 'DYLD_.*', 'GCONV_PATH', 'TMPDIR', 'GIT_.*', 'SSH_ASKPASS.*', 'SUDO_ASKPASS',
  'PERL5.*', 'PERLLIB', 'PYTHON.*', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NPM_CONFIG_.*',
  'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', 'RUBYOPT', 'RUBYLIB', 'HTTPS?_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'NO_PROXY',
  'SSL_CERT_(?:FILE|DIR)', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'UID', 'EUID', 'PPID', 'RANDOM', 'SECONDS', 'LINENO', 'OPTIND', 'OPTARG',
].join('|') + ')$');

/** A field name as an environment variable: letters, digits and _, not starting with a digit, and never one of the
 *  names a shell acts on (those get a leading _, as in _PROMPT_COMMAND). */
export function envName(k: string): string {
  const n = k.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return /^[0-9]/.test(n) || SHELL_NAMES.test(n) ? `_${n}` : n || 'VALUE';
}

/** Fields as a .env file. Anything beyond plain characters is single-quoted (a ' becomes '\''), so sourcing the
 *  file never runs or expands anything in a value: no $VAR, $(…) or backticks. Names are the sender's too, so none
 *  can be one the shell acts on (envName), and each is used once: fields whose names come out the same (no name,
 *  names in other scripts, the same name twice) become VALUE, VALUE_2, …, so none is lost to the next. */
export function toEnv(items: Revealed['items']): string {
  const used = new Set<string>();
  return items.filter((i) => i.t === 'field').map((i) => {
    const f = i as { k: string; v: string };
    const v = /^[A-Za-z0-9_./:@-]*$/.test(f.v) ? f.v : `'${f.v.replace(/'/g, "'\\''")}'`;
    const base = envName(f.k);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    return `${name}=${v}`;
  }).join('\n') + '\n';
}

/** Zip archives without ZIP64 stay under 4 GiB; above that, files are saved one by one. */
const ZIP_MAX = 4 * 1024 ** 3 - 64 * 1024 ** 2;

function save(blob: Blob, name: string, urls: string[]) {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(name);
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
  /** Cleared (or the page left): a zip still being built must not be saved, or leave a Blob URL behind. */
  const gone = useRef(false);

  const clear = () => {
    gone.current = true;
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
    // Capture: scroll and focus don't bubble to window, and a scroll inside a long note counts too.
    for (const ev of [...ACTIVITY, 'pointermove']) window.addEventListener(ev, bump, { passive: true, capture: true });
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(id);
      for (const ev of [...ACTIVITY, 'pointermove']) window.removeEventListener(ev, bump, { capture: true });
      document.removeEventListener('visibilitychange', vis);
      gone.current = true;
      urls.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const fields = data.items.filter((i) => i.t === 'field');
  /** Stored, not compressed, and streamed: each file is read a chunk at a time and the archive is built from Blob
   *  parts, so a large download never sits whole in the page's memory. */
  const zipAll = async () => {
    setZipping(true);
    const files = [...data.files]; // Clear empties data.files; this keeps going only to stop at the next check
    const out: Blob[] = [];
    try {
      const { Zip, ZipPassThrough } = await import('fflate');
      if (gone.current) return;
      let failed: Error | null = null;
      const zip = new Zip((err, chunk) => {
        if (err) failed = err;
        else out.push(new Blob([chunk]));
      });
      const names = new Set<string>();
      for (const f of files) {
        let name = safeFileName(f.name);
        while (names.has(name)) name = `copy-${name}`;
        names.add(name);
        const entry = new ZipPassThrough(name);
        zip.add(entry);
        if (!f.blob.size) entry.push(new Uint8Array(0), true);
        for (let at = 0; at < f.blob.size; at += CHUNK) {
          const part = new Uint8Array(await f.blob.slice(at, at + CHUNK).arrayBuffer());
          if (gone.current) return;
          entry.push(part, at + CHUNK >= f.blob.size);
        }
      }
      zip.end();
      if (failed) throw failed;
      if (gone.current) return;
      save(new Blob(out, { type: 'application/zip' }), `${(title || 'secret').replace(/[^\w .-]+/g, '_')}.zip`, urls.current);
    } finally {
      out.length = 0;
      if (!gone.current) setZipping(false);
    }
  };
  const zippable = data.files.length > 1 && data.files.reduce((n, f) => n + f.size, 0) < ZIP_MAX;

  return (
    <>
      <Banner kind="ok" icon="check" action={<span class="timer" aria-live="off">{t('reveal.clears_in', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}</span>}>
        {deletedNote}
      </Banner>
      {/* Said once, as the last minute starts (the countdown itself isn't announced). */}
      <div role="alert" class="clear-soon">{left <= WARN && left > 0 && (
        <Banner kind="warn" icon="clock" action={<button type="button" class="btn sm secondary" onClick={() => { last.current = Date.now(); setLeft(IDLE); }}>{t('reveal.keep_showing')}</button>}>
          {t('reveal.clear_soon')}
        </Banner>
      )}</div>
      <section class="out reveal-in" aria-label={t('reveal.secret')} tabIndex={-1}>
        <div class="out-h"><h1 class="h3">{title || t('reveal.secret')}</h1>{from && <span class="muted small">{t('reveal.from_sender', { sender: from })}</span>}</div>
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
              <button class="btn icon sm ghost" aria-label={t('reveal.copy_field', { name: it.k })} title={t('reveal.copy')} onClick={() => copyText(it.v)}><Icon name="copy" size="sm" /></button>
            </span>
          </div>
        ))}
        {data.files.map((f, i) => (
          <div class="field" key={`f${i}`}>
            <span class="k">{t('reveal.file')}</span>
            {/* A long name wraps instead of hiding its end (the extension) and the size. */}
            <span class="v file-name-wrap" title={f.name}>{f.name} <small class="muted mono" style="white-space:nowrap">{bytes(f.size)}</small></span>
            <span class="acts"><Btn kind="secondary" class="sm" icon="down" onClick={() => save(f.blob, f.name, urls.current)}>{t('reveal.save')}</Btn></span>
          </div>
        ))}
      </section>
      <div class="actions-m between">
        {(fields.length > 0 || zippable) && <div class="row">
          {fields.length > 0 && <Btn kind="secondary" icon="copy" onClick={() => copyText(toEnv(data.items), t('reveal.copied_env'))}>{t('reveal.copy_env')}</Btn>}
          {zippable && <Btn kind="secondary" icon="down" loading={zipping} onClick={zipAll}>{t('reveal.zip')}</Btn>}
        </div>}
        <button class="btn ghost" onClick={clear}>{t('reveal.clear_now')}</button>
      </div>
      <p class="fine">{t('reveal.clipboard_note')}</p>
    </>
  );
}
