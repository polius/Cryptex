/** E6 and E8: API tokens. Owners see everyone's (/server/tokens); everyone signed in has /tokens for their own. */
import { useState } from 'preact/hooks';
import { api } from '../../api/client';
import { date, relative } from '../../lib/format';
import { t } from '../../lib/i18n';
import { config, toast } from '../../lib/state';
import { Btn, Choices, copyText, ErrMsg, H1 } from '../../ui/bits';
import { AppHeader, host, Page } from '../../ui/chrome';
import { Dialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { errorText } from '../errors';
import { Heading, readOnly, sensitive, ServerShell, useServer } from './common';

interface Token {
  id: string; name: string; scopes: string[]; created_at: string; expires_at: string | null; last_used_at: string | null; hint: string;
  owner: { id: string; email: string; name: string };
}

function TokenTable({ items, showOwner, onRevoke }: { items: Token[]; showOwner: boolean; onRevoke: (tk: Token) => void }) {
  return (
    <section class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th>{showOwner && <th>Owner</th>}<th>Can</th><th>Last used</th><th>Expires</th><th><span class="sr">Actions</span></th></tr></thead>
      <tbody>
        {items.length === 0 && <tr><td colSpan={6} class="muted">No tokens yet.</td></tr>}
        {items.map((tk) => (
          <tr key={tk.id}>
            <td><b>{tk.name}</b><br /><span class="mono small muted">{tk.hint}</span></td>
            {showOwner && <td>{tk.owner.email}</td>}
            <td>{tk.scopes.map((s) => <span class="chip" key={s} style="margin-right:4px">{s === 'send' ? 'Send' : 'Request'}</span>)}</td>
            <td class="mono">{tk.last_used_at ? relative(tk.last_used_at) : 'never'}</td>
            <td class="mono">{tk.expires_at ? date(tk.expires_at) : '—'}</td>
            <td style="text-align:right">{!readOnly() && <button class="btn sm ghost danger" onClick={() => onRevoke(tk)}>Revoke</button>}</td>
          </tr>
        ))}
      </tbody>
    </table></div></section>
  );
}

function NewToken({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<'send' | 'both'>('send');
  const [days, setDays] = useState(90);
  const [created, setCreated] = useState<(Token & { token: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setErr(null);
    if (!name.trim()) return setErr('Give it a name you’ll recognize, like “CI deploys”.');
    setBusy(true);
    try {
      setCreated(await api('POST', '/me/tokens', { body: { name: name.trim(), scopes: scopes === 'both' ? ['send', 'request'] : ['send'], expires_in_days: days } }));
      setOpen(false);
      setName('');
      onCreated();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {!readOnly() && <Btn kind="primary" icon="plus" onClick={() => setOpen(true)}>New token</Btn>}
      <Dialog open={open} onClose={() => setOpen(false)} labelledBy="nt-title"
        footer={<><button class="btn secondary" onClick={() => setOpen(false)}>{t('send.cancel')}</button><Btn kind="primary" loading={busy} onClick={create}>Create token</Btn></>}>
        <h2 class="h3" id="nt-title">New API token</h2>
        <div><label class="label" for="nt-name">Name</label><input id="nt-name" class="input" value={name} maxLength={64} data-autofocus placeholder="CI deploys" onInput={(e) => setName((e.target as HTMLInputElement).value)} /></div>
        <div><span class="label" id="nt-can">Can</span><Choices label="Can" value={scopes} options={[{ value: 'send', label: 'Send' }, { value: 'both', label: 'Send and request' }]} onChange={setScopes} /></div>
        <div><span class="label">Expires after</span><Choices label="Expires after" value={days} options={[30, 90, 365].map((d) => ({ value: d, label: `${d} days` }))} onChange={setDays} /></div>
        {err && <ErrMsg>{err}</ErrMsg>}
      </Dialog>
      <Dialog open={!!created} onClose={() => setCreated(null)} labelledBy="tc-title" footer={<button class="btn primary" onClick={() => setCreated(null)} data-autofocus>{t('server.token_ack')}</button>}>
        <h2 class="h2" id="tc-title">{t('server.token_created_title')}</h2>
        <p class="muted">{t('server.token_created_body', { email: config.value?.user?.email ?? '' }).replace(config.value?.user?.email ?? '\u0000', '')}<b>{config.value?.user?.email}</b>.</p>
        {created && <>
          <div class="secret-once"><span>{created.token}</span><Btn kind="primary" class="sm" icon="copy" onClick={() => copyText(created.token)}>{t('reveal.copy')}</Btn></div>
          <dl class="kv"><dt>Name</dt><dd>{created.name}</dd><dt>Can</dt><dd>{created.scopes.map((s) => (s === 'send' ? 'Send' : 'Request')).join(', ')}</dd>
            <dt>Expires</dt><dd>{created.expires_at ? `${relative(created.expires_at)} · ${date(created.expires_at)}` : 'Never'}</dd></dl>
        </>}
      </Dialog>
    </>
  );
}

function Terminal() {
  return (
    <section class="card"><div class="card-h"><h2 class="h3">Use it from a terminal</h2></div><div class="card-b">
      <div class="terminal"><span class="c"># install once</span>{'\n'}$ brew install polius/tap/cryptex{'\n'}$ cryptex login {host()}{'\n'}$ cryptex send --once --ttl 1d &lt; .env.staging{'\n'}https://{host()}/s/k7Qp2vR9mL#X4bT…</div>
    </div></section>
  );
}

export function TokensSection() {
  const { data, reload } = useServer<{ items: Token[] }>('/server/tokens');
  const revoke = (tk: Token) => sensitive(async () => {
    await api('DELETE', `/tokens/${tk.id}`);
    toast('Token revoked');
    reload();
  });
  return (
    <ServerShell active="tokens">
      <Heading title={t('server.tokens')} lede="For the CLI and scripts. Each token belongs to a person and acts as them." action={<NewToken onCreated={reload} />} />
      {data && <TokenTable items={data.items} showOwner onRevoke={revoke} />}
      <Terminal />
    </ServerShell>
  );
}

export function MyTokens() {
  const { data, reload } = useServer<{ items: Token[] }>('/me/tokens');
  return (
    <Page header={<AppHeader />}>
      <main class="main wide" id="main">
        <div class="between">
          <div class="stack" style="gap:6px"><H1>{t('server.tokens')}</H1><p class="lede">For the CLI and scripts. A token acts as you, and can only send or ask.</p></div>
          <NewToken onCreated={reload} />
        </div>
        {data && <TokenTable items={data.items} showOwner={false} onRevoke={async (tk) => { await api('DELETE', `/tokens/${tk.id}`); toast('Token revoked'); reload(); }} />}
        <Terminal />
        <p class="fine"><Icon name="info" size="sm" /> The CLI encrypts on your computer, so even this server’s code can’t see what you send.</p>
      </main>
    </Page>
  );
}
