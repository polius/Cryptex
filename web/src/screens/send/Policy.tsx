/** The policy line and the "Change" panel (A2–A3): how long the link works, whether it's one-time, and a passphrase. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Config } from '../../api/client';
import { generatePassword } from '../../flows/send';
import { duration, EXPIRY_CHOICES, MAX_PASSPHRASE, MIN_EXPIRES_IN, unitWord } from '../../lib/format';
import { t } from '../../lib/i18n';
import { Choices, copyText, masked } from '../../ui/bits';
import { Icon } from '../../ui/icons';

export interface SendPolicy {
  /** 1: destroyed after it's opened; null: opens any number of times until it expires. */
  views: 1 | null;
  expires_in: number;
  passphraseOn: boolean;
  passphrase: string;
}

export const defaultPolicy = (c: Config): SendPolicy => ({
  views: c.defaults.views, expires_in: Math.min(c.defaults.expires_in, c.limits.max_expires_in), passphraseOn: false, passphrase: '',
});

/** Keep a remembered policy inside the server's current limits. */
export function clampPolicy(p: SendPolicy, c: Config): SendPolicy {
  return {
    views: p.views === null ? null : 1,
    expires_in: Math.min(p.expires_in, c.limits.max_expires_in),
    passphraseOn: false, passphrase: '',
  };
}

export const opensLabel = (views: number | null | undefined): string => (views === null ? t('policy.until_expiry') : t('policy.once'));

/** The rule (how often, how long, passphrase) and the create button, together right under what's being sent.
 *  "Change" opens and closes the options panel and stays put, so focus never lands on nothing. */
export function SendFoot({ items, onChange, open, button }: {
  items: ComponentChildren[]; onChange?: () => void; open?: boolean; button?: ComponentChildren;
}) {
  const live = onChange && !open;
  return (
    <div class="send-foot">
      <div class={`rule${live ? ' live' : ''}`} role="group" aria-label={t('policy.rule_label')}>
        <div class="rule-facts" id="rule-facts">{items}</div>
        {onChange && (
          <button type="button" class="btn sm ghost change" id="options-toggle" aria-expanded={!!open} aria-controls={open ? 'options' : undefined}
            aria-describedby="rule-facts" onClick={onChange}>
            <Icon name="sliders" size="sm" />{t('policy.change')}
          </button>
        )}
      </div>
      {button && <div class="send-foot-go">{button}</div>}
    </div>
  );
}

export function sendRuleItems(p: SendPolicy): ComponentChildren[] {
  return [
    <span key="v"><Icon name="eye" size="sm" />{p.views === null ? t('policy.opens_until_expiry') : t('policy.opens_once')}</span>,
    <span key="e"><Icon name="clock" size="sm" />{t('policy.expires_in', { duration: duration(p.expires_in) })}</span>,
    ...(p.passphraseOn ? [<span key="p"><Icon name="key" size="sm" />{t('policy.passphrase')}</span>] : []),
  ];
}

/** Expiry choices under the server's maximum. In the demo, every usual choice shows, and those over the limit are greyed out. */
export function expiryOptions(max: number, demo = false) {
  if (demo) return EXPIRY_CHOICES.map((s) => ({ value: s, label: duration(s), disabled: s > max ? t('policy.not_in_demo') : undefined }));
  const list = [...EXPIRY_CHOICES];
  if (!list.includes(max) && max < 30 * 86400) list.push(max);
  return list.filter((s) => s <= max).sort((a, b) => a - b).map((s) => ({ value: s, label: duration(s) }));
}

/** "Custom" in a row of choices: any value up to the server's maximum. */
export const CUSTOM = -1;
const UNITS = { minutes: 60, hours: 3600, days: 86400 } as const;
const UNIT_WORD = { minutes: 'minute', hours: 'hour', days: 'day' } as const;
type Unit = keyof typeof UNITS;
const unitOf = (s: number): Unit => (s % 86400 === 0 ? 'days' : s % 3600 === 0 ? 'hours' : 'minutes');
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** A whole number typed in; the policy follows each valid keystroke, and leaving the box snaps it into range. */
function NumberBox({ value, min, max, onChange, label, focus }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string; focus?: boolean }) {
  const [draft, setDraft] = useState(String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(String(value)), [value]);
  useEffect(() => { if (focus) ref.current?.select(); }, []);
  return (
    <input ref={ref} class="input num-box" type="text" inputMode="numeric" pattern="[0-9]*" value={draft} aria-label={label} autoComplete="off"
      onInput={(e) => {
        const raw = (e.target as HTMLInputElement).value.replace(/\D/g, '');
        setDraft(raw);
        const n = Number(raw);
        if (raw && n >= min && n <= max) onChange(n);
      }}
      onBlur={() => {
        const n = clamp(Number(draft) || min, min, max);
        setDraft(String(n));
        onChange(n);
      }} />
  );
}

export function CustomExpiry({ value, max, onChange, focus }: { value: number; max: number; onChange: (v: number) => void; focus: boolean }) {
  const [unit, setUnit] = useState<Unit>(() => unitOf(value));
  const units = (Object.keys(UNITS) as Unit[]).filter((u) => UNITS[u] <= max);
  const amount = Math.max(1, Math.round(value / UNITS[unit]));
  const apply = (n: number, u: Unit) => onChange(clamp(n * UNITS[u], MIN_EXPIRES_IN, max));
  return (
    <div class="custom-row">
      <NumberBox value={amount} min={1} max={Math.max(1, Math.floor(max / UNITS[unit]))} onChange={(n) => apply(n, unit)} label={t('policy.custom_expiry')} focus={focus} />
      <select class="input select unit-select" value={unit} aria-label={t('policy.custom_unit')}
        onChange={(e) => { const u = (e.target as HTMLSelectElement).value as Unit; setUnit(u); apply(amount, u); }}>
        {units.map((u) => <option key={u} value={u}>{unitWord(amount, UNIT_WORD[u])}</option>)}
      </select>
      <span class="muted small">{t('policy.up_to', { max: duration(max) })}</span>
    </div>
  );
}

/** A checkbox with a title and a line of help, the panel's on/off options. */
export function Check({ on, onChange, title, help, disabled }: { on: boolean; onChange: (v: boolean) => void; title: string; help: string; disabled?: boolean }) {
  return (
    <label class={`check${disabled ? ' off' : ''}`}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span><b>{title}</b><small>{help}</small></span>
    </label>
  );
}

export function PassphraseBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [generated, setGenerated] = useState(false);
  const [shown, setShown] = useState(false); // hidden like a password until asked, also after Generate
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []); // ticking "Ask for a passphrase" puts the cursor here, ready to type
  const fresh = () => {
    onChange(generatePassword());
    setGenerated(true);
  };
  return (
    <div class="pass-box">
      <div class="input mono pass-input">
        <input ref={ref} class="bare" {...masked(!shown)} data-1p-ignore data-lpignore="true" value={value} maxLength={MAX_PASSPHRASE} placeholder={t('policy.passphrase_placeholder')} aria-label={t('policy.passphrase')}
          autoComplete="off" spellcheck={false} onInput={(e) => { setGenerated(false); onChange((e.target as HTMLInputElement).value); }} />
        <button type="button" class="btn icon sm ghost pass-eye" aria-label={shown ? t('reveal.hide') : t('reveal.show')} title={shown ? t('reveal.hide') : t('reveal.show')}
          aria-pressed={shown} onClick={() => setShown(!shown)}><Icon name={shown ? 'eyeoff' : 'eye'} size="sm" /></button>
        <button type="button" class="btn icon sm ghost" title={t('policy.passphrase_generate')} aria-label={t('policy.passphrase_generate')} onClick={fresh}><Icon name="refresh" size="sm" /></button>
        <button type="button" class="btn icon sm ghost" title={t('policy.passphrase_copy')} aria-label={t('policy.passphrase_copy')} disabled={!value} onClick={() => void copyText(value)}><Icon name="copy" size="sm" /></button>
      </div>
      {generated && value && <p class="help">{t('policy.passphrase_generated')}</p>}
    </div>
  );
}

export function OptionsPanel(props: { policy: SendPolicy; onChange: (p: SendPolicy) => void; onDone: () => void; cfg: Config }) {
  const { policy: p, cfg: c } = props;
  const ref = useRef<HTMLElement>(null);
  // Opening moves focus into the panel (unless something in it, like the passphrase box, already took it).
  useEffect(() => {
    const el = ref.current;
    // The first option, not the header's Done button.
    const first = el?.querySelector<HTMLElement>('.opt');
    // The selected choice (the one radio in the Tab order), not the first in the DOM.
    if (el && first && !el.contains(document.activeElement)) (first.querySelector<HTMLElement>('[role=radio][tabindex="0"]') ?? first.querySelector<HTMLElement>('button,input'))?.focus();
  }, []);
  const set = (x: Partial<SendPolicy>) => props.onChange({ ...p, ...x });
  const custom = { value: CUSTOM, label: t('policy.custom'), disabled: c.demo ? t('policy.not_in_demo') : undefined };
  const expiry = expiryOptions(c.limits.max_expires_in, c.demo);
  // A remembered value that isn't a preset opens on Custom.
  const [customExpiry, setCustomExpiry] = useState(() => !expiry.some((o) => o.value === p.expires_in));
  const [picked, setPicked] = useState(false); // focus the number only when Custom was just chosen, not when the panel opens on it
  const oneTime = p.views === 1;
  return (
    <section class="panel" id="options" aria-label={t('policy.options_label')} ref={ref}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); props.onDone(); } }}>
      <div class="panel-h"><span class="h3">{t('policy.panel_title')}</span><button type="button" class="btn sm ghost" onClick={props.onDone}>{t('send.done')}</button></div>
      {c.demo && <p class="fine panel-note"><Icon name="info" size="sm" />{t('policy.demo_note')}</p>}
      <div class="opt">
        <span class="lbl">{t('policy.expires_after')}</span>
        <div>
          <Choices label={t('policy.expires_after')} value={customExpiry ? CUSTOM : p.expires_in} options={[...expiry, custom]}
            onChange={(v) => { setPicked(true); setCustomExpiry(v === CUSTOM); if (v !== CUSTOM) set({ expires_in: v }); }} />
          {customExpiry && <CustomExpiry value={p.expires_in} max={c.limits.max_expires_in} focus={picked} onChange={(expires_in) => set({ expires_in })} />}
        </div>
      </div>
      <div class="opt">
        <span class="lbl">{t('policy.one_time')}</span>
        <Check on={oneTime} onChange={(v) => set({ views: v ? 1 : null })} title={t('policy.destroy_after')}
          help={oneTime ? t('policy.destroy_after_on') : t('policy.destroy_after_off')} />
      </div>
      <div class="opt">
        <span class="lbl">{t('policy.passphrase')}</span>
        <div class="stack" style="gap:12px">
          <Check on={p.passphraseOn} onChange={(v) => set({ passphraseOn: v })} title={t('policy.passphrase_ask')} help={t('policy.passphrase_help')} />
          {p.passphraseOn && <PassphraseBox value={p.passphrase} onChange={(passphrase) => set({ passphrase })} />}
        </div>
      </div>
    </section>
  );
}
