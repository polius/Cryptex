/** The account vault's prompts (store/vault.ts): unlock with the password, and whether links sent from this browser
 *  join the account. Mounted only for signed-in people. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../api/client';
import { t } from '../lib/i18n';
import { config, toast } from '../lib/state';
import { errorText } from '../screens/errors';
import { adoptLocal, adoptOffer, keepLocal, signOut as signOutHere, unlockWithPassword, vault } from '../store/vault';
import { Btn, ErrMsg } from './bits';
import { Dialog } from './dialog';
import { Icon } from './icons';

const keep = () => undefined; // the unlock prompt can't be dismissed: the vault needs the password

export function VaultPrompts() {
  const v = vault.value;
  const shown = v.state === 'locked' ? 'unlock' : v.state === 'ready' && adoptOffer.value > 0 ? 'adopt' : null;
  useBackToComposer(shown);
  if (shown === 'unlock') return <Unlock />;
  if (shown === 'adopt') return <Adopt n={adoptOffer.value} />;
  return null;
}

/** These prompts open by themselves, often before the person focused anything: when the last one closes on "/",
 *  focus goes to the composer, the route's first focus, not the page heading the dialog would
 *  otherwise return to. Focus the person put anywhere else stays. */
function useBackToComposer(shown: string | null): void {
  const was = useRef(shown);
  useEffect(() => {
    const before = was.current;
    was.current = shown;
    if (!before || shown) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const a = document.activeElement;
      if (location.pathname !== '/' || (a && a !== document.body && !a.matches('[data-page-heading]'))) return;
      document.getElementById('composer')?.focus({ preventScroll: true });
    }));
  }, [shown]);
}

/** Sign out from a prompt. If the server can't be told, the session still works: say so, and stay. */
function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await signOutHere(config.value?.user?.id);
    } catch {
      toast(t('app.signout_failed'), 'error');
      setBusy(false);
    }
  };
  return <Btn kind="ghost" loading={busy} onClick={go}>{t('app.menu_signout')}</Btn>;
}

/** Enter in the field and a click on the button share one guard: a second submit while the first runs would cost
 *  another try against the sign-in limits. */
function useOnce(fn: () => Promise<void>): [boolean, () => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  return [busy, async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }];
}

function Unlock() {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, go] = useOnce(async () => {
    setErr(null);
    try {
      await unlockWithPassword(config.value!.user!.id, pw);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'wrong_password' ? t('vault.wrong_password') : errorText(e));
    }
  });
  return (
    <Dialog open onClose={keep} labelledBy="vu-title"
      footer={<><SignOutButton /><Btn kind="primary" icon="lock" loading={busy} onClick={go}>{t('vault.unlock')}</Btn></>}>
      <div class="vault-head"><span class="vault-icon"><Icon name="lock" /></span><h2 class="h3" id="vu-title">{t('vault.unlock_title')}</h2></div>
      <p class="muted small">{t('vault.unlock_body')}</p>
      <form onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <label class="label" for="vu-pw">{t('signin.password')}</label>
        <input id="vu-pw" class={`input${err ? ' err' : ''}`} type="password" autoComplete="current-password" value={pw} data-autofocus
          aria-invalid={!!err} aria-describedby={err ? 'vu-err' : undefined} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
      </form>
      {err && <ErrMsg id="vu-err">{err}</ErrMsg>}
    </Dialog>
  );
}

/** Links sent from this browser before signing in: add them to the account, or leave them in this browser. */
function Adopt({ n }: { n: number }) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await adoptLocal();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={() => void keepLocal()} labelledBy="va-title"
      footer={<><button class="btn secondary" onClick={() => void keepLocal()}>{t('vault.adopt_keep')}</button>
        <Btn kind="primary" loading={busy} onClick={add}>{t('vault.adopt_add')}</Btn></>}>
      <div class="vault-head"><span class="vault-icon"><Icon name="link" /></span><h2 class="h3" id="va-title">{t('vault.adopt_title')}</h2></div>
      <p class="muted small">{t('vault.adopt_body', { n })}</p>
    </Dialog>
  );
}
