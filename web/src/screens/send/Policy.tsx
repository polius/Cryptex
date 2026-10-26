/** The policy line and the "Change" panel (A2–A3): who can open it, how often, for how long. */
import type { ComponentChildren } from 'preact';
import type { Config } from '../../api/client';
import { generatePassphrase } from '../../flows/send';
import { duration, EXPIRY_CHOICES, VIEW_CHOICES } from '../../lib/format';
import { t } from '../../lib/i18n';
import { Choices, Radio, Switch } from '../../ui/bits';
import { Icon } from '../../ui/icons';

export interface SendPolicy {
  views: number;
  expires_in: number;
  access: 'link' | 'email' | 'org';
  email: string;
  passphraseOn: boolean;
  passphrase: string;
  notify: boolean;
}

export const defaultPolicy = (c: Config): SendPolicy => ({
  views: Math.min(c.defaults.views, c.limits.max_views), expires_in: Math.min(c.defaults.expires_in, c.limits.max_expires_in),
  access: 'link', email: '', passphraseOn: false, passphrase: '', notify: false,
});

/** Keep a remembered policy inside the server's current limits. */
export function clampPolicy(p: SendPolicy, c: Config): SendPolicy {
  return {
    ...p,
    views: Math.min(Math.max(1, p.views), c.limits.max_views),
    expires_in: Math.min(p.expires_in, c.limits.max_expires_in),
    access: (p.access === 'email' && !c.features.email_access) || (p.access === 'org' && !(c.features.org_access && c.signed_in)) ? 'link' : p.access,
    notify: p.notify && c.features.notify && c.signed_in,
    passphraseOn: false, passphrase: '', email: p.access === 'email' ? p.email : '',
  };
}

export function whoLabel(p: { access: string; email?: string }, brand: string): string {
  if (p.access === 'email') return t('policy.who_email', { email: p.email || 'one email' });
  if (p.access === 'org') return t('policy.who_org', { brand });
  return t('policy.who_link');
}

export function PolicyLine({ items, onChange, open, locked }: { items: ComponentChildren[]; onChange?: () => void; open?: boolean; locked?: boolean }) {
  return (
    <div class="policy">
      <div class="rule">
        {items}
        {locked && <span class="muted"><Icon name="lock" size="sm" />{t('policy.locked_demo')}</span>}
      </div>
      {onChange && !locked && (
        <button type="button" class="btn sm secondary" aria-expanded={open} aria-controls="options" onClick={onChange}>
          <Icon name="sliders" size="sm" />{t('policy.change')}
        </button>
      )}
    </div>
  );
}

export function sendRuleItems(p: SendPolicy, brand: string): ComponentChildren[] {
  return [
    <span key="v"><Icon name="eye" size="sm" /><b>{p.views === 1 ? t('policy.opens_once') : t('policy.opens_n', { n: p.views })}</b></span>,
    <span key="e"><Icon name="clock" size="sm" />{t('policy.expires_in', { duration: duration(p.expires_in) })}</span>,
    <span key="w"><Icon name="users" size="sm" />{whoLabel(p, brand)}</span>,
    ...(p.passphraseOn ? [<span key="p"><Icon name="key" size="sm" />{t('policy.passphrase')}</span>] : []),
  ];
}

export function expiryOptions(max: number) {
  const list = [...EXPIRY_CHOICES];
  if (!list.includes(max) && max < 30 * 86400) list.push(max);
  return list.sort((a, b) => a - b).map((s) => ({
    value: s, label: duration(s), disabled: s > max ? `This server allows up to ${duration(max)}` : undefined,
  }));
}

export function OptionsPanel(props: { policy: SendPolicy; onChange: (p: SendPolicy) => void; onDone: () => void; cfg: Config; emailError?: string }) {
  const { policy: p, cfg: c } = props;
  const set = (x: Partial<SendPolicy>) => props.onChange({ ...p, ...x });
  const viewOpts = [...new Set([...VIEW_CHOICES.filter((v) => v <= c.limits.max_views), c.limits.max_views])].sort((a, b) => a - b)
    .map((v) => ({ value: v, label: v === 1 ? t('policy.once') : t('policy.n_times', { n: v }) }));
  const brand = c.brand.name || 'your organization';
  const user = c.signed_in ? c.user : null;
  return (
    <section class="panel" id="options" aria-label="Options">
      <div class="panel-h"><span class="h3">{t('policy.panel_title')}</span><button type="button" class="btn sm ghost" onClick={props.onDone}>{t('send.done')}</button></div>
      <div class="opt">
        <span class="lbl">{t('policy.can_be_opened')}<small>{t('policy.each_reveal_counts')}</small></span>
        <Choices label={t('policy.can_be_opened')} value={p.views} options={viewOpts} onChange={(views) => set({ views })} />
      </div>
      <div class="opt">
        <span class="lbl">{t('policy.expires_after')}<small>{t('policy.first_comes')}</small></span>
        <div>
          <Choices label={t('policy.expires_after')} value={p.expires_in} options={expiryOptions(c.limits.max_expires_in)} onChange={(expires_in) => set({ expires_in })} />
          {c.limits.max_expires_in < 30 * 86400 && <p class="help">{t('policy.server_max', { duration: duration(c.limits.max_expires_in) })}</p>}
        </div>
      </div>
      <div class="opt">
        <span class="lbl" id="who-l">{t('policy.who')}</span>
        <div class="radios" role="radiogroup" aria-labelledby="who-l">
          <Radio name="who" on={p.access === 'link'} onSelect={() => set({ access: 'link' })} title={t('policy.who_link')} help={t('policy.who_link_help')} />
          <Radio name="who" on={p.access === 'email'} onSelect={() => set({ access: 'email' })} title={t('policy.who_email_label')}
            help={t('policy.who_email_help')} disabled={c.features.email_access ? undefined : 'Needs email, which the server owner hasn’t set up.'}>
            <input class={`input${props.emailError ? ' err' : ''}`} type="email" inputMode="email" autoComplete="email" placeholder="name@company.com"
              value={p.email} aria-label="Email that can open it" aria-invalid={!!props.emailError} onInput={(e) => set({ email: (e.target as HTMLInputElement).value })} />
            {props.emailError && <p class="err-msg" role="alert"><Icon name="alert" size="sm" />{props.emailError}</p>}
          </Radio>
          <Radio name="who" on={p.access === 'org'} onSelect={() => set({ access: 'org' })} title={t('policy.who_org_label', { brand })}
            help={t('policy.who_org_help', { provider: c.features.sso_name })}
            disabled={!c.features.org_access ? 'Needs single sign-on, which the server owner hasn’t set up.' : !user ? 'Sign in to use this.' : undefined} />
        </div>
      </div>
      <div class="opt">
        <span class="lbl">{t('policy.passphrase')}<small>Optional second factor</small></span>
        <div class="stack" style="gap:10px">
          <label class="row"><Switch on={p.passphraseOn} label={t('policy.passphrase')} onChange={(v) => set({ passphraseOn: v })} /><span class="muted small">{t('policy.passphrase_help')}</span></label>
          {p.passphraseOn && (
            <div class="row nowrap">
              <input class="input mono grow" value={p.passphrase} placeholder="Type one, or generate" aria-label="Passphrase" autoComplete="off" spellcheck={false}
                onInput={(e) => set({ passphrase: (e.target as HTMLInputElement).value })} />
              <button type="button" class="btn secondary" onClick={async () => set({ passphrase: await generatePassphrase() })}>{t('policy.passphrase_generate')}</button>
            </div>
          )}
        </div>
      </div>
      <div class="opt">
        <span class="lbl">{t('policy.notify')}</span>
        <label class="row">
          <Switch on={p.notify} label={t('policy.notify')} disabled={!(c.features.notify && user)} onChange={(v) => set({ notify: v })} />
          <span class="small">{c.features.notify && user ? <>Email <b>{user.email}</b></> : <span class="muted">{!c.features.notify ? 'Needs email, which the server owner hasn’t set up.' : 'Sign in to get an email.'}</span>}</span>
        </label>
      </div>
    </section>
  );
}
