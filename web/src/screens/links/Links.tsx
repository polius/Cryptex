/** /links (B1, B3): everything you sent or asked for, with statuses read again while it's open. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { fold, num, relative, stamp } from '../../lib/format';
import { t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { config, loadConfig, toast } from '../../lib/state';
import { answerLink, requestCode } from '../../flows/request';
import { receipts } from '../../store/db';
import { vault } from '../../store/vault';
import { arrowSelect, Banner, Btn, copyText, H1, Status, useTick, useViewFocus } from '../../ui/bits';
import { AppHeader, DemoQuota, Page } from '../../ui/chrome';
import { Dialog } from '../../ui/dialog';
import { Icon, Mark, type IconName } from '../../ui/icons';
import { errorText } from '../errors';
import { AskButton } from '../request/AskButton';
import { clearExpired, deleteLocked, deleteRow, isExpired, isFinal, isRequest, loadRows, opensUntilExpiry, usePoll, type Row } from './sync';

type Tab = 'all' | 'waiting' | 'done';

export function statusOf(r: Row): { kind: 'waiting' | 'opened' | 'expired' | 'destroyed'; text: string } {
  const s = r.remote?.status ?? r.local?.last_status ?? 'waiting';
  if (isRequest(r)) {
    switch (s) {
      case 'waiting': return { kind: 'waiting', text: t('status.request_waiting') };
      case 'answered': return { kind: 'opened', text: t('status.answered') };
      case 'expired': return { kind: 'expired', text: r.remote?.answered_at ? t('receipt.expired') : t('status.request_expired') };
      case 'gone': return { kind: 'expired', text: t('status.gone') };
      default: return { kind: 'destroyed', text: t('status.destroyed') };
    }
  }
  const opened = r.local?.opened_at ?? r.remote?.events?.find((e) => e.type === 'secret.revealed')?.at;
  switch (s) {
    case 'waiting':
      return { kind: 'waiting', text: t('status.waiting') };
    case 'opened':
      if (opensUntilExpiry(r) && r.remote?.views) return { kind: 'opened', text: t('status.opened_times', { n: r.remote.views }) };
      return { kind: 'opened', text: opened ? t('status.opened', { when: stamp(opened) }) : t('status.opened_plain') };
    case 'expired': // "never opened" only when it wasn't
      return { kind: 'expired', text: opened || r.remote?.opened || r.remote?.views ? t('receipt.expired') : t('status.expired') };
    case 'gone':
      return { kind: 'expired', text: t('status.gone') };
    default:
      return { kind: 'destroyed', text: r.remote?.reason === 'too_many_tries' ? t('status.too_many_tries') : r.remote?.reason === 'reported' ? t('receipt.removed_reported') : t('status.destroyed') };
  }
}

/** Signed in, and the vault is locked (the unlock prompt): the account's links show, without what the vault keeps
 *  for them (titles, copies of links). */
export const vaultLocked = (): boolean => !!config.value?.signed_in && vault.value.state === 'locked';

/** The name shown in Your links: the sender's rename, the title, the field or file names, or "Message · 14:03". */
export function displayName(r: Row): string {
  if (!r.local) return vaultLocked() ? t('links.locked_name') : t('links.other_device');
  return r.local.label || r.local.title || r.local.hint || (isRequest(r) ? t('links.request_title', { code: requestCode(r.id) }) : t('links.message_title', { when: stamp(r.local.created_at) }));
}

/** A request's answer can be opened: it's in, and still opens. */
export const answerReady = (r: Row): boolean => isRequest(r) && r.remote?.status === 'answered' && !!r.remote.answer;

/** Open a request's answer: its own link, opened with the private key from the vault, on the usual reveal page. */
export async function openAnswer(r: Row): Promise<void> {
  try {
    navigate(await answerLink(r.local, r.remote!));
  } catch (e) {
    toast((e as Error)?.message === 'locked' ? t('ask.unlock') : errorText(e), 'error');
  }
}

/** Delete, while the vault is locked: it waits (sync.ts deleteLocked), and says why. */
export const deleteBlocked = (): boolean => {
  if (!deleteLocked()) return false;
  toast(t('links.delete_locked'), 'info');
  return true;
};

/** Destroy: a link that still works stops working (when this browser can destroy it), and it leaves Your links. */
export function DeleteDialog({ row, onClose, onDeleted }: { row: Row | null; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await deleteRow(row!);
      toast(t('links.deleted'));
      onClose();
      onDeleted();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!row} alert onClose={onClose} labelledBy="dl-title"
      footer={<><button class="btn secondary" onClick={onClose} data-autofocus>{t('dialog.destroy_keep')}</button>
        <Btn kind="danger solid" icon="trash" loading={busy} onClick={go}>{t('links.delete')}</Btn></>}>
      <h2 class="h2" id="dl-title">{t(row && isRequest(row) ? 'links.delete_title_request' : 'links.delete_title', { title: row ? displayName(row) : '' })}</h2>
      <p class="muted">{t(row && isRequest(row) ? (isFinal(row) ? 'links.delete_body' : 'links.delete_body_request')
        : row && !isFinal(row) && row.local ? 'links.delete_body_live' : 'links.delete_body')}</p>
    </Dialog>
  );
}

/** Clear all expired links from Your links: they no longer work, so only the history goes. */
function ClearDialog({ rows, onClose, onCleared }: { rows: Row[] | null; onClose: () => void; onCleared: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await clearExpired(rows!);
      toast(t('links.cleared'));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
      onClose();
      onCleared(); // also after a failure part-way: the list shows what's left
    }
  };
  return (
    <Dialog open={!!rows} alert onClose={onClose} labelledBy="cl-title"
      footer={<><button class="btn secondary" onClick={onClose} data-autofocus>{t('send.cancel')}</button>
        <Btn kind="danger solid" icon="trash" loading={busy} onClick={go}>{t('links.clear_expired')}</Btn></>}>
      <h2 class="h2" id="cl-title">{t('links.clear_title')}</h2>
      <p class="muted">{t('links.clear_body')}</p>
    </Dialog>
  );
}

/** Rename a link in Your links. Only this browser keeps the name; the recipient's view doesn't change. */
export function RenameDialog({ row, onClose, onSaved }: { row: Row | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState('');
  useEffect(() => setV(row?.local?.label || row?.local?.title || ''), [row?.id]);
  const save = async () => {
    if (!row) return;
    const name = v.trim();
    try {
      await receipts.patch(row.id, { label: name && name !== (row.local?.title || '') ? name : undefined });
    } catch (e) {
      toast(errorText(e), 'error'); // the vault couldn't save it: keep the dialog, and what was typed
      return;
    }
    toast(t('links.renamed'));
    onClose();
    onSaved();
  };
  return (
    <Dialog open={!!row} onClose={onClose} labelledBy="rn-title"
      footer={<><button class="btn secondary" onClick={onClose}>{t('send.cancel')}</button><Btn kind="primary" onClick={save}>{t('links.rename_save')}</Btn></>}>
      <h2 class="h3" id="rn-title">{t('links.rename_title')}</h2>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input class="input" value={v} maxLength={120} placeholder={row ? displayName({ ...row, local: row.local && { ...row.local, label: undefined } }) : ''} aria-label={t('links.rename_label')} data-autofocus onInput={(e) => setV((e.target as HTMLInputElement).value)} />
      </form>
      <p class="muted small">{row && isRequest(row) ? t('links.rename_help_request') : row?.local?.title ? t('links.rename_help_title', { title: row.local.title }) : t('links.rename_help')}</p>
    </Dialog>
  );
}

export function kindIcon(r: Row): IconName {
  if (isRequest(r)) return 'inbox';
  return r.local && r.local.fields === 0 && r.local.files > 0 ? 'file' : 'key';
}

export function subtitle(r: Row): string {
  if (isRequest(r)) return r.local || !vaultLocked() ? t('links.request_sub') : t('links.locked_sub');
  if (!r.local) return vaultLocked() ? t('links.locked_sub') : t('links.other_device_sub');
  const contents = t('links.contents', { fields: r.local.fields, files: r.local.files, both: r.local.fields > 0 && r.local.files > 0 }) || t('links.contents_message');
  return t('links.subtitle', { other: !!r.local.other_device, sent: t('links.sent_kind', { contents }) });
}

export function when(r: Row): string {
  const exp = answerReady(r) ? r.remote!.answer!.expires_at : r.remote?.expires_at ?? r.local?.expires_at;
  if (!isFinal(r) && exp) return t('links.expires_when', { when: relative(exp) });
  const ended = r.local?.ended_at ?? r.remote?.ended_at;
  return ended ? stamp(ended) : '';
}

/** Every word typed must appear in the link's name, title, contents, status or ID. */
export function matches(r: Row, q: string): boolean {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([displayName(r), subtitle(r), r.local?.title, r.local?.label, r.local?.hint, statusOf(r).text, r.id].filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
}

export function Links() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [clearing, setClearing] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  useTick(30_000);
  useEffect(() => void (config.value?.demo && loadConfig().catch(() => undefined)), []); // today's demo quota, as the server counts it
  useViewFocus(rows === null ? null : 'list'); // the heading of the loaded page (the placeholder's is gone)
  const loads = useRef(0);

  const load = async () => {
    const n = ++loads.current;
    let r: Row[];
    try {
      r = await loadRows();
    } catch (e) {
      // Locked meanwhile: the unlock prompt is up, and this runs again once it opens. Anything else: say so.
      if (n === loads.current && (e as Error)?.message !== 'locked') setFailed(true);
      return;
    }
    if (n !== loads.current) return; // a later load is on its way, with newer statuses
    setFailed(false);
    setRows(r);
  };
  const retry = async () => {
    setRetrying(true);
    await load();
    setRetrying(false);
  };

  // Again once the vault opens (the unlock prompt), so the account's links appear without a reload.
  const unlocked = vault.value.state === 'ready';
  useEffect(() => void load(), [unlocked]);
  usePoll(load);

  // "/" jumps to the search box, as on most sites with a list to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input,textarea,select,[contenteditable]');
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const loadFailed = failed && (
    <Banner kind="danger" icon="alert" action={<Btn kind="secondary" class="sm" icon="refresh" loading={retrying} onClick={() => void retry()}>{t('send.try_again')}</Btn>}>
      {t('links.load_failed')}
    </Banner>
  );

  if (rows === null) {
    return <Page header={<AppHeader active="links" />}><main class="main wide" id="main"><H1>{t('links.title')}</H1>{loadFailed || <div class="rows placeholder" aria-busy="true" />}</main></Page>;
  }

  const found = rows.filter((r) => matches(r, q));
  const counts = { all: found.length, waiting: found.filter((r) => !isFinal(r)).length, done: found.filter(isFinal).length };
  const shown = found.filter((r) => tab === 'all' || (tab === 'waiting' ? !isFinal(r) : isFinal(r)));

  /** A menu item that opens a dialog: focus goes back to the menu's button first, so the dialog returns it there. */
  const pick = (open: () => void) => () => {
    document.querySelector<HTMLElement>('[aria-controls="row-menu"]')?.focus();
    setMenu(null);
    open();
  };

  if (!rows.length) {
    return (
      <Page header={<AppHeader active="links" />}>
        <main class="main wide" id="main">
          <div class="stack" style="gap:6px"><H1>{t('links.title')}</H1><p class="lede">{t('links.empty_lede')}</p><DemoQuota pill /></div>
          {loadFailed}
          <div class="empty">
            <span class="tint"><Mark /></span>
            <h2 class="h3">{t('links.empty_title')}</h2>
            <p class="muted">{t('links.empty_body')}</p>
            <div class="row" style="justify-content:center">
              <a class="btn primary" href="/"><Icon name="send" size="sm" />{t('links.empty_send')}</a>
              <AskButton />
            </div>
          </div>
          <StorageNote />
        </main>
      </Page>
    );
  }

  return (
    <Page header={<AppHeader active="links" />}>
      <main class="main wide" id="main">
        <div class="stack" style="gap:6px"><H1>{t('links.title')}</H1><p class="lede">{t(config.value?.signed_in ? 'links.lede' : 'links.lede_local')}</p><DemoQuota pill /></div>
        {loadFailed}
        <div class="links-bar">
          <div class="tabs" role="tablist" aria-label={t('links.filter_label')} onKeyDown={arrowSelect}>
            {(['all', 'waiting', 'done'] as Tab[]).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} aria-controls="link-rows" tabIndex={tab === k ? 0 : -1} class={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
                {t(`links.tab_${k}`)} <span class="n">{num(counts[k])}</span>
              </button>
            ))}
          </div>
          <div class="links-tools">
            {rows.some(isExpired) && (
              <Btn kind="secondary" class="links-clear" icon="trash" unavailable={deleteLocked()} title={deleteLocked() ? t('links.delete_locked') : undefined}
                onClick={() => deleteBlocked() || setClearing(rows.filter(isExpired))}><span class="links-clear-l">{t('links.clear_expired')}</span></Btn>
            )}
            <label class="input search links-search">
              <Icon name="search" size="sm" />
              <input ref={search} class="bare" type="search" value={q} placeholder={t('links.search')} aria-label={t('links.search')} autoComplete="off" spellcheck={false}
                onInput={(e) => setQ((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ(''); } }} />
              {q ? (
                <button type="button" class="btn icon sm ghost" aria-label={t('links.search_clear')} title={t('links.search_clear')}
                  onClick={() => { setQ(''); search.current?.focus(); }}><Icon name="x" size="sm" /></button>
              ) : <kbd aria-hidden="true">/</kbd>}
            </label>
          </div>
        </div>
        <div class="rows" role="list" id="link-rows">
          {shown.length === 0 && (q.trim() ? (
            <div class="r-empty muted">{t('links.search_empty', { q: q.trim() })}{' '}
              <button type="button" class="link" onClick={() => { setQ(''); search.current?.focus(); }}>{t('links.search_clear')}</button></div>
          ) : <div class="r-empty muted">{t('links.tab_empty')}</div>)}
          {shown.map((r) => {
            const st = statusOf(r);
            const final = isFinal(r);
            const key = r.id;
            return (
              <div class={`r${final ? ' dim' : ''}`} role="listitem" key={key}>
                <span class="kind" aria-hidden="true"><Icon name={kindIcon(r)} /></span>
                <a class="t" href={`/r/${r.id}`}>
                  <b>{displayName(r)}</b>
                  <small>{subtitle(r)}</small>
                </a>
                <span class="s"><Status kind={st.kind}>{st.text}</Status></span>
                <span class="when">{when(r)}</span>
                <span class="acts">
                  {answerReady(r) ? <Btn kind="primary" class="sm" icon="eye" onClick={() => void openAnswer(r)}>{t('links.open_answer')}</Btn>
                    : !final && r.local?.link && <Btn kind="secondary" class="sm" icon="copy" onClick={() => copyText(r.local!.link!, t('toast.link_copied'))}>{t('links.copy')}</Btn>}
                  <div class="has-pop">
                    <button type="button" class="btn icon sm ghost" aria-label={t('links.more')} title={t('links.more')} aria-haspopup="menu" aria-expanded={menu === key}
                      aria-controls={menu === key ? 'row-menu' : undefined}
                      onClick={() => setMenu(menu === key ? null : key)}><Icon name="more" size="sm" /></button>
                    {menu === key && (
                      <RowMenu onClose={() => setMenu(null)}>
                        {r.local && <button class="mi" role="menuitem" tabIndex={-1} onClick={pick(() => setRenaming(r))}><Icon name="pencil" size="sm" />{t('links.rename')}</button>}
                        {/* Destroy, as on the receipt page: the link stops working and leaves Your links. */}
                        <button class="mi danger" role="menuitem" tabIndex={-1} aria-disabled={deleteLocked() || undefined} title={deleteLocked() ? t('links.delete_locked') : undefined}
                          onClick={pick(() => deleteBlocked() || setDeleting(r))}><Icon name="trash" size="sm" />{t('links.delete')}</button>
                      </RowMenu>
                    )}
                  </div>
                </span>
              </div>
            );
          })}
        </div>
        <StorageNote />
        <DeleteDialog row={deleting} onClose={() => setDeleting(null)} onDeleted={() => void load()} />
        <ClearDialog rows={clearing} onClose={() => setClearing(null)} onCleared={() => void load()} />
        <RenameDialog row={renaming} onClose={() => setRenaming(null)} onSaved={() => void load()} />
      </main>
    </Page>
  );
}

/** Where Your links live: the account vault (signed in), or this browser only. The demo points to a server of your own. */
function StorageNote() {
  const c = config.value;
  if (c?.signed_in) return <p class="store-note"><Icon name="lock" size="sm" /><span>{t('links.note_account')}</span></p>;
  if (c?.demo) {
    return (
      <p class="store-note">
        <Icon name="info" size="sm" />
        <span>{t('links.note_demo')} <a class="link" href="https://github.com/polius/cryptex" rel="external noopener" target="_blank">{t('demo.self_host')}</a></span>
      </p>
    );
  }
  return <p class="store-note"><Icon name="info" size="sm" /><span>{c?.features.sign_in ? t('links.note_local_signin') : t('links.note_local')}</span></p>;
}

/** A menu (WAI-ARIA menu button pattern): arrow keys, Home and End move between items; Esc and Tab close it, and
 *  Esc returns focus to its button. */
function RowMenu({ children, onClose }: { children: preact.ComponentChildren; onClose: () => void }) {
  useEffect(() => {
    const trigger = document.querySelector<HTMLElement>('[aria-controls="row-menu"]');
    const onKey = (e: KeyboardEvent) => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('.row-menu .mi'));
      const i = items.indexOf(document.activeElement as HTMLElement);
      const to = (n: number) => {
        e.preventDefault();
        items[(n + items.length) % items.length]?.focus();
      };
      if (e.key === 'Escape') {
        onClose();
        trigger?.focus();
      } else if (e.key === 'Tab') onClose();
      else if (e.key === 'ArrowDown') to(i + 1);
      else if (e.key === 'ArrowUp') to(i - 1);
      else if (e.key === 'Home') to(0);
      else if (e.key === 'End') to(items.length - 1);
    };
    // A press on the menu's own button is left to its click, which closes the menu (instead of closing here and
    // the click opening it again).
    const onDown = (e: MouseEvent) => !(e.target as Element).closest('.row-menu') && !trigger?.contains(e.target as Node) && onClose();
    document.addEventListener('keydown', onKey);
    setTimeout(() => document.addEventListener('mousedown', onDown));
    const pop = document.querySelector<HTMLElement>('.row-menu');
    // Open upward when the menu would run past the bottom of the screen.
    if (pop && pop.getBoundingClientRect().bottom > window.innerHeight - 8) pop.classList.add('up');
    (document.querySelector('.row-menu .mi') as HTMLElement | null)?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, []);
  return <><div class="menu-scrim" onClick={onClose} aria-hidden="true" /><div class="menu-pop row-menu" id="row-menu" role="menu" aria-label={t('links.more')}>{children}</div></>;
}
