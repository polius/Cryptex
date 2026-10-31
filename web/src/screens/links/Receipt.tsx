/** /r/:id (B2): status timeline for one secret, read again while it's open. */
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api, type Receipt as R } from '../../api/client';
import { justAsked, lookupRequests, requestCode } from '../../flows/request';
import { dateTime, duration, relative, stamp } from '../../lib/format';
import { t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { toast } from '../../lib/state';
import { receipts, type StoredReceipt } from '../../store/db';
import { vault } from '../../store/vault';
import { Banner, Btn, H1, Outcome, Status, useViewFocus } from '../../ui/bits';
import { AppHeader, Page } from '../../ui/chrome';
import { Icon, type IconName } from '../../ui/icons';
import { LinkBox, LinkReady } from '../send/LinkReady';
import { AskButton } from '../request/AskButton';
import { opensLabel } from '../send/Policy';
import { errorText } from '../errors';
import { answerReady, deleteBlocked, DeleteDialog, displayName, openAnswer, RenameDialog, statusOf, vaultLocked } from './Links';
import { deleteLocked, deleteRow, isFinal, isRequest, opensUntilExpiry, persist, usePoll, type Row } from './sync';

export function Receipt({ id }: { id: string }) {
  const asked = justAsked.value;
  if (asked?.item.id === id) return <RequestReady item={asked.item} copied={asked.copied} />;
  return <ReceiptPage id={id} />;
}

/** A request just made: its link, ready to send, like a sent link's page (Home). Done, or leaving, shows its status. */
function RequestReady({ item, copied }: { item: StoredReceipt; copied: boolean }) {
  useEffect(() => () => {
    if (justAsked.peek()?.item.id === item.id) justAsked.value = null;
  }, [item.id]);
  return (
    <Page header={<AppHeader active="links" />}>
      <main class="main send-page arrive" id="main">
        <LinkReady copied={copied} copiedLabel={t('ask.copied')} title={t('ask.ready_title')} status={t('status.request_waiting')} link={item.link!}
          hint={t('ask.share_hint')}
          facts={[
            { k: t('ask.code'), v: requestCode(item.id) },
            { k: t('send.fact_expires'), v: dateTime(item.expires_at!), sub: relative(item.expires_at!) },
          ]}
          destroyLabel={t('links.delete')} destroyTitle={t('links.delete_title_request')} destroyBody={t('links.delete_body_request')}
          onDestroy={async () => {
            await deleteRow({ local: item, remote: null, id: item.id }); // a failure stays in LinkReady's dialog
            toast(t('links.deleted'));
            justAsked.value = null;
            navigate('/links', { replace: true });
          }}
          actions={<>
            <AskButton />
            <Btn kind="primary" onClick={() => { justAsked.value = null; }}>{t('send.done')}</Btn>
          </>} />
      </main>
    </Page>
  );
}

function ReceiptPage({ id }: { id: string }) {
  const [row, setRow] = useState<Row | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The heading once the page has loaded (the loading card has none), and again when what it shows changes.
  useViewFocus(missing ? 'missing' : row ? 'row' : failed ? 'failed' : null);

  const load = async (): Promise<void> => {
    let local: StoredReceipt | undefined = await receipts.get(id);
    let remote: R | null = null;
    if (local?.kind === 'request') remote = (await lookupRequests([local]))[0] ?? null;
    if (local?.kind === 'request' && !remote && !local.ended_at) {
      local = { ...local, last_status: 'gone', link: undefined, key: undefined, ended_at: new Date().toISOString() }; // closed or long gone
      await receipts.put(local, true);
    } else if (!remote && local?.kind !== 'request') {
      try {
        remote = await api<R>('GET', `/receipts/${id}`, local ? { headers: { Authorization: `Manage ${local.manage_token}` } } : {});
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
      }
    }
    if (!local && !remote) {
      setMissing(true);
      return;
    }
    const r: Row = { local: local ?? null, remote, id };
    await persist(r);
    setMissing(false);
    setRow({ ...r });
  };

  // Again once the vault opens.
  const unlocked = vault.value.state === 'ready';
  useEffect(() => {
    setFailed(null);
    // Each load says afresh whether it's there: not found while the vault was locked can be found once it opens.
    setMissing(false);
    if (row?.id !== id) setRow(null); // another link's page: nothing of the last one stays
    load().catch((e) => {
      // Locked meanwhile (the unlock prompt is up): this runs again. Offline or a server error: say so.
      if ((e as Error)?.message !== 'locked') setFailed(errorText(e));
    });
  }, [id, unlocked, attempt]);
  usePoll(() => load().catch(() => undefined), !!row && !isFinal(row));

  if (missing) {
    return (
      <Page header={<AppHeader active="links" />}>
        <main class="main" id="main">
          <a class="btn sm ghost rc-back" href="/links"><Icon name="back" size="sm" />{t('links.title')}</a>
          <Outcome icon="search" tone="info" title={t('errors.not_found')}
            actions={<a class="btn secondary" href="/links">{t('links.title')}</a>}>{t('receipt.missing_body')}</Outcome>
        </main>
      </Page>
    );
  }
  if (!row && failed) {
    return (
      <Page header={<AppHeader active="links" />}>
        <main class="main" id="main">
          <a class="btn sm ghost rc-back" href="/links"><Icon name="back" size="sm" />{t('links.title')}</a>
          <Banner kind="danger" icon="alert">{failed}</Banner>
          <div class="row"><Btn kind="secondary" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>{t('send.try_again')}</Btn></div>
        </main>
      </Page>
    );
  }
  if (!row) return <Page header={<AppHeader active="links" />}><main class="main" id="main" aria-busy="true"><div class="card rc-hero rc-loading" /></main></Page>;

  if (isRequest(row)) {
    return <RequestView row={row} deleting={deleting} setDeleting={setDeleting} onRenamed={() => void load()} />;
  }
  const st = statusOf(row);
  const final = isFinal(row);
  const title = displayName(row);
  const opened = (row.remote?.events ?? []).some((e) => e.type === 'secret.revealed');
  const statusText = row.remote?.status === 'opened' && final ? t('status.opened_destroyed') : st.text;
  const look = LOOK[st.kind === 'destroyed' && row.remote?.reason === 'too_many_tries' ? 'tries' : st.kind === 'opened' && final ? 'done' : st.kind];
  const live = !final && !!row.local;
  const many = opensUntilExpiry(row);
  const exp = row.remote?.expires_at ?? row.local?.expires_at;
  const ended = row.remote?.ended_at ?? row.local?.ended_at;
  const created = row.remote?.created_at ?? row.local?.created_at;
  const contents = row.local ? cap(t('reveal.contents', { fields: row.local.fields, files: row.local.files, both: row.local.fields > 0 && row.local.files > 0 }) || t('send.contains_message')) : '—';
  const facts: Array<{ k: string; v: string; sub?: string; full?: string }> = [
    { k: t('send.fact_opens'), v: opensLabel(many ? null : 1), sub: many && row.remote?.views ? t('status.opened_times', { n: row.remote.views }) : undefined },
    !final && exp ? { k: t('send.fact_expires'), v: stamp(exp), sub: relative(exp), full: dateTime(exp) }
      : { k: t('receipt.ended'), v: ended ? stamp(ended) : '—', sub: ended ? relative(ended) : undefined, full: ended ? dateTime(ended) : undefined },
    ...(row.remote?.passphrase ? [{ k: t('policy.passphrase'), v: t('receipt.passphrase_needed') }] : []),
    { k: t('send.fact_contains'), v: contents },
  ];
  const steps = timeline(row);
  if (!final && row.remote) steps.push({ title: t('send.waiting'), sub: exp ? cap(t('links.expires_when', { when: relative(exp) })) : undefined, dot: 'pending' });

  return (
    <Page header={<AppHeader active="links" />}>
      <main class="main" id="main">
        <a class="btn sm ghost rc-back" href="/links"><Icon name="back" size="sm" />{t('links.title')}</a>

        <section class="card rc-hero" aria-label={title}>
          <div class="rc-head">
            <span class={`rc-icon ${look.tone}`} aria-hidden="true"><Icon name={look.icon} /></span>
            <div class="rc-titles">
              <Status kind={st.kind}>{statusText}</Status>
              <div class="title-row"><H1 class="rc-title">{title}</H1>
                {row.local && <button type="button" class="btn icon sm ghost" aria-label={t('links.rename')} title={t('links.rename')} onClick={() => setRenaming(true)}><Icon name="pencil" size="sm" /></button>}</div>
              <p class="rc-meta">{row.local ? <>{created && <time dateTime={created} title={dateTime(created)}>{t('receipt.sent_at', { when: stamp(created) })}</time>}</> : t(vaultLocked() ? 'links.locked_sub' : 'links.other_device_sub')}</p>
            </div>
          </div>
          {!final && row.local?.link && <div class="rc-link"><LinkBox link={row.local.link} /></div>}
          <div class="facts rc-facts">
            {facts.map((f) => <div key={f.k}><small>{f.k}</small><b title={f.full}>{f.v}</b>{f.sub && <span>{f.sub}</span>}</div>)}
          </div>
        </section>

        <section class="rc-activity" aria-labelledby="rc-activity">
          <div class="rc-sec-h">
            <h2 class="h3" id="rc-activity">{t('receipt.activity')}</h2>
            {live && <span class="rc-live"><i aria-hidden="true" />{t('receipt.live')}</span>}
          </div>
          <div class="card"><div class="card-b">
            <ol class="events">
              {steps.map((x, i) => (
                <li key={i} class={x.dot === 'pending' ? 'pending' : undefined}>
                  <span class={`dot ${x.dot}`}>{(x.dot === 'ink' || x.dot === 'ok' || x.dot === 'warn') && <Icon name={x.dot === 'warn' ? 'alert' : 'check'} />}</span>
                  <span><b>{x.title}</b>{x.sub && <small>{x.sub}</small>}</span>
                  {x.at ? <time dateTime={x.at} title={dateTime(x.at)}>{stamp(x.at)}</time> : <span />}
                </li>
              ))}
            </ol>
            {opened && <p class="rc-note"><Icon name="alert" size="sm" /><span><b>{t('receipt.unexpected_title')}</b> {t('receipt.unexpected_body')}</span></p>}
          </div></div>
        </section>

        <div class="rc-actions">
          <span class="sp" />
          {/* Destroy: the link stops working and leaves Your links (deleteRow). While the vault is locked it says why. */}
          <button class="btn secondary danger" aria-disabled={deleteLocked() || undefined} title={deleteLocked() ? t('links.delete_locked') : undefined}
            onClick={() => deleteBlocked() || setDeleting(true)}><Icon name="trash" size="sm" />{t('links.delete')}</button>
        </div>
        <DeleteDialog row={deleting ? row : null} onClose={() => setDeleting(false)} onDeleted={() => navigate('/links')} />
        <RenameDialog row={renaming ? row : null} onClose={() => setRenaming(false)} onSaved={() => void load()} />
      </main>
    </Page>
  );
}

interface Step {
  title: string;
  sub?: string;
  at?: string;
  dot: 'ink' | 'ok' | 'warn' | 'pending' | '';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The status icon at the top of the page, by state. */
const LOOK: Record<string, { icon: IconName; tone: 'info' | 'ok' | 'warn' | 'muted' }> = {
  waiting: { icon: 'hourglass', tone: 'info' },
  opened: { icon: 'eye', tone: 'ok' },
  done: { icon: 'check', tone: 'ok' },
  expired: { icon: 'clock', tone: 'muted' },
  destroyed: { icon: 'trash', tone: 'muted' },
  tries: { icon: 'alert', tone: 'warn' },
};

function timeline(row: Row): Step[] {
  const out: Step[] = [];
  for (const e of row.remote?.events ?? []) {
    const d = e.detail as Record<string, number | string | boolean>;
    switch (e.type) {
      case 'secret.created':
        out.push({ title: row.local && !row.local.other_device ? t('receipt.created') : t('receipt.created_other'), at: e.at, dot: 'ink',
          sub: cap(t('receipt.created_detail', { once: d.views === 1, duration: duration(Number(d.expires_in)), passphrase: !!d.passphrase })) });
        break;
      case 'secret.revealed':
        out.push({ title: t('receipt.revealed'), at: e.at, dot: 'ok', sub: d.views_left === 0 ? t('receipt.revealed_detail') : t('receipt.revealed_still_works') });
        break;
      case 'secret.passphrase_failed':
        out.push({ title: t('receipt.wrong_passphrase'), at: e.at, dot: 'warn', sub: t('receipt.tries_left', { n: Number(d.tries_left) }) });
        break;
      case 'secret.destroyed':
        out.push({ title: d.reason === 'too_many_tries' ? t('status.too_many_tries') : d.reason === 'reported' ? t('receipt.removed_reported') : t('status.destroyed'), at: e.at, dot: 'warn' });
        break;
      case 'secret.expired':
        out.push({ title: Number(d.views_used) ? t('receipt.expired') : t('status.expired'), at: e.at, dot: '' });
        break;
    }
  }
  if (!out.length && row.local?.last_status === 'gone') {
    if (row.local.created_at) out.push({ title: t('receipt.created'), at: row.local.created_at, dot: 'ink' });
    out.push({ title: t('status.gone'), at: row.local.ended_at, dot: '', sub: t('receipt.gone_detail') });
  }
  if (!out.length) out.push({ title: row.remote ? statusOf(row).text : t('receipt.status_unavailable'), dot: '' });
  return out;
}

/** A request's page: its link while it waits, Open answer once the answer is in, and what happened. */
function RequestView({ row, deleting, setDeleting, onRenamed }: { row: Row; deleting: boolean; setDeleting: (v: boolean) => void; onRenamed: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const st = statusOf(row);
  const final = isFinal(row);
  const r = row.remote;
  const s = r?.status ?? row.local?.last_status ?? 'waiting';
  const look = s === 'waiting' ? LOOK.waiting : s === 'answered' ? { icon: 'inbox' as const, tone: 'ok' as const } : LOOK[st.kind];
  const created = r?.created_at ?? row.local?.created_at;
  const ended = r?.ended_at ?? row.local?.ended_at;
  const exp = r?.answer?.expires_at ?? r?.expires_at;
  // The code is already the title ("Request KFX-49M") until it's renamed.
  const facts: Array<{ k: string; v: string; sub?: string; full?: string }> = row.local?.label ? [{ k: t('ask.code'), v: requestCode(row.id) }] : [];
  if (answerReady(row)) facts.push({ k: t('receipt.answered'), v: stamp(r!.answered_at!), sub: relative(r!.answered_at!), full: dateTime(r!.answered_at!) });
  if (!final && exp) facts.push({ k: t('send.fact_expires'), v: stamp(exp), sub: relative(exp), full: dateTime(exp) });
  if (final) facts.push({ k: t('receipt.ended'), v: ended ? stamp(ended) : '—', sub: ended ? relative(ended) : undefined, full: ended ? dateTime(ended) : undefined });
  if (r?.answer?.passphrase) facts.push({ k: t('policy.passphrase'), v: t('receipt.passphrase_needed') });

  const steps: Step[] = [];
  if (created) steps.push({ title: t('receipt.request_created'), at: created, dot: 'ink' });
  if (r?.answered_at) steps.push({ title: t('receipt.answered'), at: r.answered_at, dot: 'ok' });
  if (r?.views) steps.push({ title: t('status.opened_times', { n: r.views }), dot: 'ok' });
  if (!final) steps.push({ title: s === 'waiting' ? t('status.request_waiting') : r?.views ? t('receipt.revealed_still_works') : t('send.waiting'), sub: exp ? cap(t('links.expires_when', { when: relative(exp) })) : undefined, dot: 'pending' });
  else steps.push({ title: st.text, at: ended, dot: s === 'destroyed' ? 'warn' : '' });

  return (
    <Page header={<AppHeader active="links" />}>
      <main class="main" id="main">
        <a class="btn sm ghost rc-back" href="/links"><Icon name="back" size="sm" />{t('links.title')}</a>
        <section class="card rc-hero" aria-label={displayName(row)}>
          <div class="rc-head">
            <span class={`rc-icon ${look.tone}`} aria-hidden="true"><Icon name={look.icon} /></span>
            <div class="rc-titles">
              <Status kind={st.kind}>{st.text}</Status>
              <div class="title-row"><H1 class="rc-title">{displayName(row)}</H1>
                {row.local && <button type="button" class="btn icon sm ghost" aria-label={t('links.rename')} title={t('links.rename')} onClick={() => setRenaming(true)}><Icon name="pencil" size="sm" /></button>}</div>
              <p class="rc-meta">{row.local || !vaultLocked() ? created && <time dateTime={created} title={dateTime(created)}>{t('receipt.asked_at', { when: stamp(created) })}</time> : t('links.locked_sub')}</p>
            </div>
          </div>
          {s === 'waiting' && row.local?.link && <div class="rc-link"><LinkBox link={row.local.link} /><p class="muted small">{t('ask.share_hint')}</p></div>}
          {answerReady(row) && (
            <div class="rc-link"><Btn kind="primary" class="lg" icon="eye" onClick={() => void openAnswer(row)}>{t('links.open_answer')}</Btn>
              <p class="muted small">{t('receipt.answer_hint')}</p></div>
          )}
          <div class="facts rc-facts">
            {facts.map((f) => <div key={f.k}><small>{f.k}</small><b title={f.full}>{f.v}</b>{f.sub && <span>{f.sub}</span>}</div>)}
          </div>
        </section>

        <section class="rc-activity" aria-labelledby="rc-activity">
          <div class="rc-sec-h">
            <h2 class="h3" id="rc-activity">{t('receipt.activity')}</h2>
            {!final && <span class="rc-live"><i aria-hidden="true" />{t('receipt.live')}</span>}
          </div>
          <div class="card"><div class="card-b">
            <ol class="events">
              {steps.map((x, i) => (
                <li key={i} class={x.dot === 'pending' ? 'pending' : undefined}>
                  <span class={`dot ${x.dot}`}>{(x.dot === 'ink' || x.dot === 'ok' || x.dot === 'warn') && <Icon name={x.dot === 'warn' ? 'alert' : 'check'} />}</span>
                  <span><b>{x.title}</b>{x.sub && <small>{x.sub}</small>}</span>
                  {x.at ? <time dateTime={x.at} title={dateTime(x.at)}>{stamp(x.at)}</time> : <span />}
                </li>
              ))}
            </ol>
          </div></div>
        </section>

        <div class="rc-actions">
          <span class="sp" />
          <button class="btn secondary danger" aria-disabled={deleteLocked() || undefined} title={deleteLocked() ? t('links.delete_locked') : undefined}
            onClick={() => deleteBlocked() || setDeleting(true)}><Icon name="trash" size="sm" />{t('links.delete')}</button>
        </div>
        <DeleteDialog row={deleting ? row : null} onClose={() => setDeleting(false)} onDeleted={() => navigate('/links')} />
        <RenameDialog row={renaming ? row : null} onClose={() => setRenaming(false)} onSaved={onRenamed} />
      </main>
    </Page>
  );
}
