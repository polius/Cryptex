/** C1: ask someone for a secret. Fields are suggested from the title until you edit them. */
import type { Config } from '../../api/client';
import { duration } from '../../lib/format';
import { t } from '../../lib/i18n';
import { Choices, Switch } from '../../ui/bits';
import { Icon } from '../../ui/icons';

export interface RequestDraft {
  title: string;
  fields: Array<{ id: number; name: string }>;
  touched: boolean;
  files: boolean;
  message: string;
  expires_in: number;
  keep: number;
  notify: boolean;
}

let seq = 0;
const row = (name: string) => ({ id: ++seq, name });

const SUGGEST: Array<[RegExp, string[]]> = [
  [/\baws\b|amazon/i, ['Access key ID', 'Secret access key']],
  [/azure|entra/i, ['Tenant ID', 'Client ID', 'Client secret']],
  [/\bgcp\b|google cloud|service account/i, ['Service account key']],
  [/database|\bdb\b|postgres|mysql|mongo|redis|\bsql\b/i, ['Host', 'Username', 'Password']],
  [/\bssh\b|private key/i, ['Private key']],
  [/wi-?fi/i, ['Network', 'Password']],
  [/\bvpn\b/i, ['Username', 'Password']],
  [/api|token|webhook|\bkey\b/i, ['API key']],
  [/login|account|password|credential|sign.?in/i, ['Username', 'Password']],
];

export function suggestFields(title: string): string[] | null {
  for (const [re, f] of SUGGEST) if (re.test(title)) return f;
  return null;
}

export const newRequestDraft = (c: Config): RequestDraft => ({
  title: '', fields: [row('Password')], touched: false, files: false, message: '',
  expires_in: Math.min(7 * 86400, c.limits.request_max_expires_in), keep: Math.min(7 * 86400, c.limits.request_max_keep), notify: false,
});

const LIFETIMES = [3600, 86400, 7 * 86400, 30 * 86400];
const opts = (max: number) => {
  const list = LIFETIMES.filter((s) => s <= max);
  if (!list.includes(max)) list.push(max);
  return list.map((s) => ({ value: s, label: duration(s) }));
};

export function requestRuleItems(d: RequestDraft) {
  return [
    <span key="a"><Icon name="eye" size="sm" /><b>{t('request.answers_once')}</b></span>,
    <span key="l"><Icon name="clock" size="sm" />{t('request.link_works', { duration: duration(d.expires_in) })}</span>,
    <span key="w"><Icon name="users" size="sm" />{t('policy.who_link')}</span>,
    <span key="k"><Icon name="inbox" size="sm" />{t('request.keep_answer', { duration: duration(d.keep) })}</span>,
  ];
}

export function RequestComposer({ d, set, disabled, maxFiles }: { d: RequestDraft; set: (p: Partial<RequestDraft>) => void; disabled?: boolean; maxFiles: number }) {
  const suggested = !d.touched && !!suggestFields(d.title);
  return (
    <section class="composer" aria-label="Request">
      <div class="cmp-title">
        <input class="t" value={d.title} maxLength={120} placeholder="What do you need?" aria-label="What you need" disabled={disabled} data-autofocus
          onInput={(e) => {
            const title = (e.target as HTMLInputElement).value;
            const s = !d.touched ? suggestFields(title) : null;
            set({ title, ...(s ? { fields: s.map(row) } : {}) });
          }} />
        <p class="hint">{t('request.title_hint')}</p>
      </div>
      <div class="items">
        {d.fields.map((f, i) => (
          <div class="field edit" key={f.id}>
            <span class="k"><input value={f.name} placeholder="Field name" aria-label={`Field ${i + 1} name`} maxLength={80} disabled={disabled}
              onInput={(e) => set({ touched: true, fields: d.fields.map((x) => (x.id === f.id ? { ...x, name: (e.target as HTMLInputElement).value } : x)) })} /></span>
            <span class="v ph">{t('request.field_placeholder')}</span>
            <span class="acts">
              <button type="button" class="btn icon sm ghost" aria-label={`Remove ${f.name || 'field'}`} title="Remove" disabled={disabled || d.fields.length === 1}
                onClick={() => set({ touched: true, fields: d.fields.filter((x) => x.id !== f.id) })}><Icon name="x" size="sm" /></button>
            </span>
          </div>
        ))}
      </div>
      <div class="cmp-bar">
        <button type="button" class="btn sm ghost" disabled={disabled || d.fields.length >= 20} onClick={() => {
          set({ touched: true, fields: [...d.fields, row('')] });
          setTimeout(() => (document.querySelector('.field.edit:last-child .k input') as HTMLInputElement | null)?.focus());
        }}><Icon name="plus" size="sm" />{t('request.ask_field')}</button>
        {maxFiles > 0 && (
          <button type="button" class={`btn sm ghost${d.files ? ' on' : ''}`} aria-pressed={d.files} disabled={disabled} onClick={() => set({ files: !d.files })}>
            <Icon name={d.files ? 'check' : 'clip'} size="sm" />{t('request.allow_files')}
          </button>
        )}
        <span class="sp" />
        {suggested && <span class="detected"><Icon name="scan" size="sm" />{t('request.suggested')}</span>}
      </div>
    </section>
  );
}

export function RequestOptions({ d, set, cfg, onDone }: { d: RequestDraft; set: (p: Partial<RequestDraft>) => void; cfg: Config; onDone: () => void }) {
  const user = cfg.signed_in ? cfg.user : null;
  return (
    <section class="panel" id="options" aria-label="Options">
      <div class="panel-h"><span class="h3">How long the link and the answer last</span><button type="button" class="btn sm ghost" onClick={onDone}>{t('send.done')}</button></div>
      <div class="opt"><span class="lbl">Link works for<small>{t('request.answers_once')}</small></span>
        <Choices label="Link works for" value={d.expires_in} options={opts(cfg.limits.request_max_expires_in)} onChange={(expires_in) => set({ expires_in })} /></div>
      <div class="opt"><span class="lbl">Keep the answer<small>After it arrives</small></span>
        <Choices label="Keep the answer" value={d.keep} options={opts(cfg.limits.request_max_keep)} onChange={(keep) => set({ keep })} /></div>
      <div class="opt"><span class="lbl">Tell me when it’s answered</span>
        <label class="row">
          <Switch on={d.notify} label="Tell me when it’s answered" disabled={!(cfg.features.notify && user)} onChange={(notify) => set({ notify })} />
          <span class="small">{cfg.features.notify && user ? <>Email <b>{user.email}</b></> : <span class="muted">{!cfg.features.notify ? 'Needs email, which the server owner hasn’t set up.' : 'Sign in to get an email.'}</span>}</span>
        </label>
      </div>
    </section>
  );
}
