/** /links (B1, B3): everything you sent or asked for, with live statuses. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { destroySecret } from '../../flows/send';
import { cancelRequest } from '../../flows/request';
import { relative, stamp } from '../../lib/format';
import { t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { config, toast } from '../../lib/state';
import { receipts } from '../../store/db';
import { Btn, copyText, H1, Status, useTick } from '../../ui/bits';
import { AppHeader, Page } from '../../ui/chrome';
import { Dialog } from '../../ui/dialog';
import { Icon, Mark, type IconName } from '../../ui/icons';
import { errorText } from '../errors';
import { isFinal, loadRows, needsYou, subscribe, type Row } from './sync';

type Tab = 'all' | 'needs' | 'waiting' | 'done';

export function statusOf(r: Row): { kind: 'waiting' | 'opened' | 'expired' | 'answer' | 'destroyed'; text: string } {
  const s = r.remote?.status ?? r.local?.last_status ?? 'waiting';
  const opened = r.local?.opened_at ?? r.remote?.events?.find((e) => e.type === 'secret.revealed')?.at;
  const max = r.remote?.max_views ?? r.local?.views ?? 1;
  switch (s) {
    case 'waiting':
      return { kind: 'waiting', text: r.kind === 'request' ? t('status.no_answer') : t('status.waiting') };
    case 'opened':
      if (max > 1 && (r.remote?.views_left ?? 0) > 0) return { kind: 'opened', text: t('status.opened_n', { used: max - (r.remote?.views_left ?? 0), max }) };
      return { kind: 'opened', text: opened ? t('status.opened', { when: stamp(opened) }) : t('status.opened', { when: '' }).trim() };
    case 'answered':
      return { kind: 'answer', text: t('status.answer_waiting') };
    case 'revealed':
      return { kind: 'opened', text: t('status.answered', { when: stamp(r.remote?.answered_at ?? r.local?.ended_at ?? Date.now()) }) };
    case 'expired':
      return { kind: 'expired', text: r.kind === 'request' ? 'Expired' : t('status.expired') };
    case 'cancelled':
      return { kind: 'destroyed', text: t('status.cancelled') };
    default:
      return { kind: 'destroyed', text: r.remote?.reason === 'too_many_tries' ? t('status.too_many_tries') : t('status.destroyed') };
  }
}

export function kindIcon(r: Row): IconName {
  if (r.kind === 'request') return 'inbox';
  return r.local && r.local.fields === 0 && r.local.files > 0 ? 'file' : 'key';
}

export function subtitle(r: Row): string {
  if (!r.local) return t('links.other_device');
  const contents = t('links.contents', { fields: r.local.fields, files: r.local.files, both: r.local.fields > 0 && r.local.files > 0 }) || 'a message';
  const base = r.kind === 'request' ? t('links.request_kind', { contents: r.local.files && r.kind === 'request' ? `${r.local.fields} fields, files` : contents })
    : t('links.sent_kind', { contents });
  const who = r.local.access === 'email' && r.local.email ? ` · only ${r.local.email}` : r.local.access === 'org' ? ' · org only' : '';
  return `${r.local.other_device ? 'From another device · ' : ''}${base}${who}`;
}

export function when(r: Row): string {
  const exp = r.remote?.expires_at ?? r.local?.expires_at;
  if (!isFinal(r) && exp) return r.kind === 'request' && r.remote?.status !== 'answered' ? `link open ${relative(exp).replace(/^in /, '')}` : `expires ${relative(exp)}`;
  const ended = r.local?.ended_at ?? r.remote?.ended_at;
  return ended ? stamp(ended) : '';
}

export function Links() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [menu, setMenu] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  useTick(30_000);
  const live = useRef<() => void>(() => undefined);

  const load = async () => {
    const r = await loadRows();
    setRows(r);
    live.current();
    live.current = subscribe(r, () => void load());
  };

  useEffect(() => {
    void load();
    return () => live.current();
  }, []);

  if (rows === null) {
    return <Page header={<AppHeader active="links" />}><main class="main wide" id="main"><H1>{t('links.title')}</H1><div class="rows placeholder" aria-busy="true" /></main></Page>;
  }

  const counts = { all: rows.length, needs: rows.filter(needsYou).length, waiting: rows.filter((r) => !isFinal(r) && !needsYou(r)).length, done: rows.filter(isFinal).length };
  const shown = rows.filter((r) => tab === 'all' || (tab === 'needs' ? needsYou(r) : tab === 'waiting' ? !isFinal(r) && !needsYou(r) : isFinal(r)));

  const remove = async (r: Row) => {
    await receipts.remove(r.kind, r.id);
    if (config.value?.signed_in) await fetch(`/api/v1/me/receipts/${r.id}`, { method: 'DELETE', headers: { 'X-CSRF': config.value.csrf ?? '' } }).catch(() => undefined);
    setMenu(null);
    void load();
  };

  const destroy = async (r: Row) => {
    try {
      if (r.kind === 'secret') await destroySecret(r.id, r.local!.manage_token);
      else await cancelRequest(r.id, r.local!.manage_token);
      toast(r.kind === 'secret' ? t('toast.destroyed') : 'Request cancelled');
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setConfirm(null);
    void load();
  };

  if (!rows.length) {
    return (
      <Page header={<AppHeader active="links" />}>
        <main class="main wide" id="main">
          <div class="stack" style="gap:6px"><H1>{t('links.title')}</H1><p class="lede">Everything you send or ask for shows up here, with when it was opened.</p></div>
          <div class="empty">
            <span class="tint"><Mark /></span>
            <h2 class="h3">{t('links.empty_title')}</h2>
            <p class="muted" style="max-width:46ch">{t('links.empty_body')}</p>
            <div class="row" style="justify-content:center">
              <a class="btn primary" href="/"><Icon name="send" size="sm" />{t('links.empty_send')}</a>
              <a class="btn secondary" href="/?mode=request"><Icon name="inbox" size="sm" />{t('links.empty_ask')}</a>
            </div>
            <button type="button" class="link small" onClick={() => setImportOpen(true)}>{t('links.import_receipt')}</button>
          </div>
          <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
        </main>
      </Page>
    );
  }

  return (
    <Page header={<AppHeader active="links" />}>
      <main class="main wide" id="main">
        <div class="between">
          <div class="stack" style="gap:6px"><H1>{t('links.title')}</H1><p class="lede">{t('links.lede')}</p></div>
          <a class="btn primary hide-m" href="/"><Icon name="plus" size="sm" />{t('app.nav_new')}</a>
        </div>
        <div class="tabs" role="tablist" aria-label="Filter">
          {(['all', 'needs', 'waiting', 'done'] as Tab[]).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} class={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
              {t(`links.tab_${k === 'needs' ? 'needs_you' : k}`)} <span class="n">{counts[k]}</span>
            </button>
          ))}
        </div>
        <div class="rows" role="list">
          {shown.length === 0 && <div class="r-empty muted">Nothing here.</div>}
          {shown.map((r) => {
            const st = statusOf(r);
            const final = isFinal(r);
            const key = `${r.kind}:${r.id}`;
            return (
              <div class={`r${needsYou(r) ? ' attn' : ''}${final ? ' dim' : ''}`} role="listitem" key={key}>
                <span class="kind" aria-hidden="true"><Icon name={kindIcon(r)} /></span>
                <a class="t" href={`/r/${r.id}${r.kind === 'request' ? '?kind=request' : ''}`}>
                  <b>{r.local?.title || (r.kind === 'request' ? 'Untitled request' : r.local ? 'Untitled secret' : t('links.other_device'))}</b>
                  <small>{subtitle(r)}</small>
                </a>
                <span class="s"><Status kind={st.kind}>{st.text}</Status></span>
                <span class="when">{when(r)}</span>
                <span class="acts">
                  {needsYou(r) && r.local && <Btn kind="primary" class="sm" onClick={() => navigate(`/r/${r.id}?kind=request&reveal=1`)}>{t('links.reveal_answer')}</Btn>}
                  {!final && !needsYou(r) && r.local?.link && <Btn kind="secondary" class="sm" icon="copy" onClick={() => copyText(r.local!.link!, t('toast.link_copied'))}>{t('links.copy')}</Btn>}
                  <div class="has-pop">
                    <button type="button" class="btn icon sm ghost" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={menu === key}
                      onClick={() => setMenu(menu === key ? null : key)}><Icon name="more" size="sm" /></button>
                    {menu === key && (
                      <RowMenu onClose={() => setMenu(null)}>
                        {r.local && <button class="mi" role="menuitem" onClick={() => {
                          setMenu(null);
                          void copyText(`${location.origin}/r/${r.id}#manage=${r.kind === 'request' ? 'q.' : ''}${r.local!.manage_token}`, 'Receipt link copied');
                        }}><Icon name="link" size="sm" />{t('links.copy_receipt_link')}</button>}
                        {!final && r.local && <button class="mi danger" role="menuitem" onClick={() => { setMenu(null); setConfirm(r); }}>
                          <Icon name="trash" size="sm" />{r.kind === 'secret' ? t('send.destroy_now') : t('request.cancel')}</button>}
                        <button class="mi" role="menuitem" onClick={() => remove(r)}><Icon name="x" size="sm" />{t('links.remove')}</button>
                      </RowMenu>
                    )}
                  </div>
                </span>
              </div>
            );
          })}
        </div>
        <p class="fine">Using another device? Open a link’s menu and choose <b>{t('links.copy_receipt_link')}</b>{config.value?.signed_in ? '. Statuses already sync to your account.' : ', or sign in to sync.'}</p>
        <Dialog open={!!confirm} alert onClose={() => setConfirm(null)} labelledBy="ld-title"
          footer={<><button class="btn secondary" onClick={() => setConfirm(null)} data-autofocus>{t('dialog.destroy_keep')}</button>
            <Btn kind="danger solid" icon="trash" onClick={() => destroy(confirm!)}>{confirm?.kind === 'request' ? 'Cancel request' : t('dialog.destroy_confirm')}</Btn></>}>
          <h2 class="h2" id="ld-title">{confirm?.kind === 'request' ? 'Cancel this request?' : t('dialog.destroy_title')}</h2>
          <p class="muted">{confirm?.kind === 'request' ? `“${confirm?.local?.title}” stops working now.` : t('dialog.destroy_body', { title: confirm?.local?.title || 'This secret' })}</p>
        </Dialog>
      </main>
    </Page>
  );
}

function RowMenu({ children, onClose }: { children: preact.ComponentChildren; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: MouseEvent) => !(e.target as Element).closest('.row-menu') && onClose();
    document.addEventListener('keydown', onKey);
    setTimeout(() => document.addEventListener('mousedown', onDown));
    (document.querySelector('.row-menu .mi') as HTMLElement | null)?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, []);
  return <><div class="menu-scrim" onClick={onClose} aria-hidden="true" /><div class="menu-pop row-menu" role="menu">{children}</div></>;
}

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const go = () => {
    const m = /\/r\/([0-9A-Za-z]{10})#manage=([A-Za-z0-9_.-]+)/.exec(v.trim());
    if (!m) {
      setErr('Paste the whole receipt link, including everything after #.');
      return;
    }
    onClose();
    navigate(`/r/${m[1]}#manage=${m[2]}`);
  };
  return (
    <Dialog open={open} onClose={onClose} labelledBy="imp-title"
      footer={<><button class="btn secondary" onClick={onClose}>{t('dialog.close')}</button><Btn kind="primary" onClick={go}>Add to Your links</Btn></>}>
      <h2 class="h3" id="imp-title">{t('links.import_receipt')}</h2>
      <p class="muted small">On the other device, open the link’s menu in Your links and choose <b>{t('links.copy_receipt_link')}</b>. It shows the status and lets you destroy it; it can’t open the secret.</p>
      <input class={`input mono${err ? ' err' : ''}`} value={v} placeholder="https://…/r/…#manage=…" aria-label="Receipt link" data-autofocus onInput={(e) => setV((e.target as HTMLInputElement).value)} />
      {err && <p class="err-msg" role="alert"><Icon name="alert" size="sm" />{err}</p>}
    </Dialog>
  );
}
