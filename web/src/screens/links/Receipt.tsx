/** /r/:id (B2): status timeline for one secret or request, live. Also imports `#manage=` receipt links
 *  and reveals request answers with the private key kept on this device. */
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api, type Receipt as R } from '../../api/client';
import { cancelRequest, NoKey, readAnswer } from '../../flows/request';
import type { Revealed } from '../../flows/reveal';
import { destroySecret } from '../../flows/send';
import { dateTime, duration, stamp } from '../../lib/format';
import { t } from '../../lib/i18n';
import { dropFragment, navigate, route } from '../../lib/router';
import { toast } from '../../lib/state';
import { receipts, requestKeys, type StoredReceipt } from '../../store/db';
import { Banner, Btn, copyText, H1, Status } from '../../ui/bits';
import { AppHeader, Page } from '../../ui/chrome';
import { Dialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { errorText } from '../errors';
import { Output } from '../reveal/Output';
import { statusOf } from './Links';
import { isFinal, persist, subscribe, type Row } from './sync';

export function Receipt({ id }: { id: string }) {
  const [row, setRow] = useState<Row | null>(null);
  const [missing, setMissing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [answer, setAnswer] = useState<Revealed | null>(null);
  const [answerErr, setAnswerErr] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [cleared, setCleared] = useState(false);
  const kindHint = route.value.query.get('kind') === 'request' ? 'request' : null;

  const load = async (): Promise<Row | null> => {
    let local: StoredReceipt | undefined = kindHint ? await receipts.get('request', id) : (await receipts.get('secret', id)) ?? (await receipts.get('request', id));
    // Receipt link from another device: /r/{id}#manage=<token> (q. prefix for requests).
    const m = /^manage=(q\.)?([A-Za-z0-9_-]{43})$/.exec(route.value.hash);
    if (m) {
      dropFragment();
      try {
        const rec = await api<R>('GET', `/receipts/${id}`, { headers: { Authorization: `Manage ${m[2]}` } });
        if (!local) {
          local = { kind: rec.kind, id, manage_token: m[2], title: '', created_at: rec.created_at ?? new Date().toISOString(), expires_at: rec.expires_at,
            last_status: rec.status, fields: 0, files: 0, other_device: true };
          await receipts.put(local);
        }
        toast(t('toast.receipt_imported'));
      } catch {
        toast('That receipt link didn’t work. It may be incomplete or expired.', 'error');
      }
    }
    let remote: R | null = null;
    try {
      remote = await api<R>('GET', `/receipts/${id}`, local ? { headers: { Authorization: `Manage ${local.manage_token}` } } : {});
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
    if (!local && !remote) {
      setMissing(true);
      return null;
    }
    const r: Row = { local: local ?? null, remote, kind: (remote?.kind ?? local!.kind), id };
    await persist(r);
    setRow({ ...r });
    return r;
  };

  useEffect(() => {
    let stop = () => {};
    void load().then((r) => {
      if (r) stop = subscribe([r], () => void load());
      if (r && route.value.query.get('reveal') === '1') void reveal(r);
    });
    return () => stop();
  }, [id]);

  async function reveal(r: Row) {
    if (!r.local) return;
    setReading(true);
    setAnswerErr(null);
    try {
      setAnswer(await readAnswer(id, r.local.manage_token));
      void load();
    } catch (e) {
      setAnswerErr(e instanceof NoKey ? 'This device doesn’t have the key that opens the answer. Open it on the device you used to ask, or use the backup link you saved.'
        : errorText(e));
    } finally {
      setReading(false);
    }
  }

  if (missing) {
    return (
      <Page header={<AppHeader active="links" />}>
        <main class="main" id="main">
          <a class="btn sm ghost" href="/links" style="justify-self:start"><Icon name="back" size="sm" />{t('links.title')}</a>
          <H1>{t('errors.not_found')}</H1>
          <p class="lede">This receipt isn’t on this device. Receipts from another device need their receipt link.</p>
        </main>
      </Page>
    );
  }
  if (!row) return <Page header={<AppHeader active="links" />}><main class="main" id="main" aria-busy="true" /></Page>;

  const st = statusOf(row);
  const final = isFinal(row);
  const ev = row.remote?.events ?? [];
  const title = row.local?.title || (row.kind === 'request' ? 'Request' : row.local ? 'Secret' : t('links.other_device'));
  const status = row.remote?.status;
  const opened = ev.some((e) => e.type === 'secret.revealed');
  const statusText = row.kind === 'secret' && status === 'opened' && final ? 'Opened and destroyed' : st.text;

  return (
    <Page header={<AppHeader active="links" />}>
      <main class="main" id="main">
        <a class="btn sm ghost" href="/links" style="justify-self:start"><Icon name="back" size="sm" />{t('links.title')}</a>
        <div class="stack" style="gap:10px">
          <H1>{title}</H1>
          <Status kind={st.kind}>{statusText}</Status>
        </div>

        {answer && !cleared ? (
          <Output data={answer} title={title} from={null} deletedNote={`Decrypted on this device. The answer stays on the server until ${row.remote?.kept_until ? dateTime(row.remote.kept_until) : 'it expires'} unless you destroy it.`}
            onCleared={() => setCleared(true)} />
        ) : (
          <>
            {row.kind === 'request' && (status === 'answered' || status === 'revealed') && row.local && (
              <div class="card"><div class="card-b between">
                <span><b>{status === 'answered' ? t('status.answer_waiting') : 'You opened the answer'}</b><br />
                  <span class="muted small">{row.remote?.kept_until ? `Kept until ${dateTime(row.remote.kept_until)}` : ''}</span></span>
                <Btn kind="primary" icon="eye" loading={reading} onClick={() => reveal(row)}>{t('links.reveal_answer')}</Btn>
              </div></div>
            )}
            {answerErr && <Banner kind="danger" icon="alert">{answerErr}</Banner>}
            {cleared && <Banner kind="ok" icon="check">Cleared from this page.</Banner>}
            <section class="card"><div class="card-b">
              <ol class="events">
                {timeline(row).map((x, i) => (
                  <li key={i}>
                    <span class={`dot ${x.dot}`}>{x.dot !== '' && <Icon name={x.dot === 'warn' ? 'alert' : 'check'} />}</span>
                    <span><b>{x.title}</b>{x.sub && <small>{x.sub}</small>}</span>
                    <time dateTime={x.at}>{x.at ? stamp(x.at) : ''}</time>
                  </li>
                ))}
              </ol>
            </div></section>
          </>
        )}

        {row.kind === 'secret' && opened && !answer && (
          <Banner kind="warn" icon="alert"><b>{t('receipt.unexpected_title')}</b> {t('receipt.unexpected_body')}</Banner>
        )}
        {!final && row.local?.link && <Btn kind="secondary" icon="copy" class="sm" onClick={() => copyText(row.local!.link!, t('toast.link_copied'))}>Copy link</Btn>}
        <div class="actions-m between">
          {row.local ? <button class="btn ghost hide-m" onClick={async () => {
            await receipts.remove(row.kind, id);
            if (row.kind === 'request') await requestKeys.remove(id);
            navigate('/links');
          }}>{t('links.remove')}</button> : <span />}
          <div class="row">
            {!final && row.local && <button class="btn danger" onClick={() => setConfirm(true)}><Icon name="trash" size="sm" />{row.kind === 'secret' ? t('send.destroy_now') : status === 'answered' ? 'Destroy answer' : t('request.cancel')}</button>}
            <a class="btn secondary" href={row.kind === 'request' ? '/?mode=request' : '/'}><Icon name="plus" size="sm" />{row.kind === 'request' ? 'Ask for another' : t('receipt.send_new')}</a>
          </div>
        </div>
        <Dialog open={confirm} alert onClose={() => setConfirm(false)} labelledBy="rd-title"
          footer={<><button class="btn secondary" onClick={() => setConfirm(false)} data-autofocus>{t('dialog.destroy_keep')}</button>
            <Btn kind="danger solid" icon="trash" onClick={async () => {
              try {
                if (row.kind === 'secret') await destroySecret(id, row.local!.manage_token);
                else await cancelRequest(id, row.local!.manage_token);
                toast(t('toast.destroyed'));
              } catch (e) {
                toast(errorText(e), 'error');
              }
              setConfirm(false);
              void load();
            }}>{t('dialog.destroy_confirm')}</Btn></>}>
          <h2 class="h2" id="rd-title">{row.kind === 'secret' ? t('dialog.destroy_title') : 'Destroy this request?'}</h2>
          <p class="muted">{row.kind === 'secret' ? t('dialog.destroy_body', { title }) : `“${title}” and any answer are deleted from the server now. This can’t be undone.`}</p>
        </Dialog>
      </main>
    </Page>
  );
}

interface Step {
  title: string;
  sub?: string;
  at?: string;
  dot: 'ink' | 'ok' | 'warn' | '';
}

function timeline(row: Row): Step[] {
  const out: Step[] = [];
  for (const e of row.remote?.events ?? []) {
    const d = e.detail as Record<string, number | string | boolean>;
    switch (e.type) {
      case 'secret.created':
        out.push({ title: row.local && !row.local.other_device ? t('receipt.created') : 'Created', at: e.at, dot: 'ink',
          sub: [d.views === 1 ? 'opens once' : `opens ${d.views} times`, d.access === 'email' ? 'one email' : d.access === 'org' ? 'org only' : 'anyone with the link',
            `expires in ${duration(Number(d.expires_in))}`, d.passphrase ? 'passphrase' : ''].filter(Boolean).join(' · ') });
        break;
      case 'secret.revealed':
        out.push({ title: t('receipt.revealed'), at: e.at, dot: 'ok', sub: Number(d.views_left) === 0 ? t('receipt.revealed_detail') : `${d.views_left} opens left` });
        break;
      case 'secret.passphrase_failed':
        out.push({ title: 'Wrong passphrase', at: e.at, dot: 'warn', sub: `${d.tries_left} tries left` });
        break;
      case 'secret.code_failed':
        out.push({ title: 'Wrong email code', at: e.at, dot: 'warn', sub: `${d.tries_left} tries left` });
        break;
      case 'secret.destroyed':
        out.push({ title: d.reason === 'too_many_tries' ? t('status.too_many_tries') : d.reason === 'reported' ? 'Removed after a report' : 'Destroyed', at: e.at, dot: 'warn' });
        break;
      case 'secret.expired':
        out.push({ title: Number(d.views_used) ? 'Expired' : t('status.expired'), at: e.at, dot: '' });
        break;
      case 'request.created':
        out.push({ title: row.local && !row.local.other_device ? 'Request created on this device' : 'Request created', at: e.at, dot: 'ink',
          sub: `link works ${duration(Number(d.expires_in))} · answer kept ${duration(Number(d.keep_answer_s))}` });
        break;
      case 'request.answered':
        out.push({ title: 'Answered', at: e.at, dot: 'ok', sub: 'Encrypted for you; the server can’t read it' });
        break;
      case 'request.answer_read':
        out.push({ title: 'You opened the answer', at: e.at, dot: 'ok' });
        break;
      case 'request.cancelled':
        out.push({ title: 'Cancelled', at: e.at, dot: '' });
        break;
      case 'request.expired':
        out.push({ title: d.answered ? 'Answer deleted after its keep time' : 'Expired without an answer', at: e.at, dot: '' });
        break;
    }
  }
  if (!out.length) out.push({ title: row.remote ? statusOf(row).text : 'Status unavailable', dot: '' });
  return out;
}
