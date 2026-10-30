/** Page chrome: brand, headers, account menu, demo bar, footer, toasts. */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { initials, shortDuration } from '../lib/format';
import { rich, t } from '../lib/i18n';
import { navigate, route } from '../lib/router';
import { config, shownUser, dismiss, linksCount, setTheme, theme, toast, toasts, type Theme } from '../lib/state';
import { arrowSelect } from './bits';
import { useFocusTrap } from './dialog';
import { Icon, Mark } from './icons';

/** The brand, a link home on app pages. `link={false}` on pages for recipients: one stray click there would leave a
 *  revealed secret behind for good. */
export function Brand({ sub = true, link = true }: { sub?: boolean; link?: boolean }) {
  const c = config.value;
  const name = c?.brand.name?.trim();
  const lockup = <BrandLockup name={name} logoUrl={c?.brand.logo_url} sub={sub} />;
  if (!link) return <span class="brand">{lockup}</span>;
  return (
    <a class="brand" href="/" aria-label={name ? t('app.brand_label', { name, suffix: t('app.brand_suffix') }) : t('app.home_label')}>
      {lockup}
    </a>
  );
}

/** The server's logo (the Cryptex mark until one is uploaded) and its name (the wordmark until one is set). */
export function BrandLockup({ name, logoUrl, sub = false }: { name?: string; logoUrl?: string | null; sub?: boolean }) {
  return <>
    {logoUrl ? <img class="op-logo img" src={logoUrl} alt="" /> : <Mark />}
    {name ? <><span class="op-name">{name}</span>{sub && <span class="op-sub">{t('app.brand_suffix')}</span>}</> : <span class="wordmark">cryptex</span>}
  </>;
}

export function host(): string {
  return location.host;
}

/** Recipient and responder pages: the brand, nothing to click away to, and a theme picker (there's no account menu
 *  here). */
export function RecipientHeader() {
  return (
    <header class="hd">
      <Brand link={false} />
      <span class="sp" />
      <ThemePicker />
    </header>
  );
}

const THEME_ICON = { auto: 'contrast', light: 'sun', dark: 'moon' } as const;

/** This device's theme on pages without the account menu: its icon over a native select. */
export function ThemePicker() {
  return (
    <span class="theme-pick" title={t('app.menu_theme')}>
      <Icon name={THEME_ICON[theme.value]} size="sm" />
      <select aria-label={t('app.menu_theme')} value={theme.value} onChange={(e) => setTheme((e.target as HTMLSelectElement).value as Theme)}>
        {(['auto', 'light', 'dark'] as const).map((x) => <option key={x} value={x}>{t(`app.theme_${x}`)}</option>)}
      </select>
    </span>
  );
}

export function AppHeader({ active }: { active?: 'new' | 'links' | 'server' }) {
  const c = config.value;
  const user = shownUser(c);
  const owner = user?.role === 'owner';
  const [open, setOpen] = useState(false);
  const canSend = !!user || c?.mode === 'anyone';
  return (
    <header class="hd">
      <Brand />
      {c?.demo && <DemoChip />}
      <span class="sp" />
      <nav aria-label={t('app.nav_label')}>
        {canSend && <a class={`navlink nav-new${active === 'new' ? ' on' : ''}`} href="/" aria-current={active === 'new' ? 'page' : undefined}><Icon name="plus" size="sm" /><span class="nav-l">{t('app.nav_new')}</span></a>}
        {canSend && (
          <a class={`navlink${active === 'links' ? ' on' : ''}`} href="/links" aria-current={active === 'links' ? 'page' : undefined}>
            {t('app.nav_links')}{linksCount.value > 0 && <span class="count" aria-label={t('app.links_waiting', { n: linksCount.value })}>{linksCount.value}</span>}
          </a>
        )}
        {owner && <a class={`navlink hide-m${active === 'server' ? ' on' : ''}`} href="/server" aria-current={active === 'server' ? 'page' : undefined}><Icon name="gauge" size="sm" />{t('app.nav_server')}</a>}
        {!user && !canSend && route.value.path !== '/signin' && <a class="navlink" href="/signin">{t('app.nav_signin')}</a>}
      </nav>
      <div class="has-pop">
        <button class={user ? 'avatar' : 'avatar anon'} aria-label={t('app.account_menu')} aria-expanded={open} aria-controls={open ? 'account-menu' : undefined}
          title={user?.username || t('app.menu')} onClick={() => setOpen(!open)} id="account-button">
          {user ? initials(user.username) : <Icon name="user" size="sm" />}
        </button>
        {open && <AccountMenu onClose={() => setOpen(false)} />}
      </div>
    </header>
  );
}

/** A panel of links and settings (not an ARIA menu: it holds a radio group). Esc closes it. */
function AccountMenu({ onClose }: { onClose: () => void }) {
  const c = config.value;
  const user = shownUser(c);
  const ref = useFocusTrap(true, onClose);
  // A click anywhere outside closes the menu (on phones the scrim covers the page and does the same).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!ref.current?.contains(target) && !target.closest('#account-button')) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);
  const go = (to: string) => () => {
    onClose();
    navigate(to);
  };
  const signOut = async () => {
    if (c?.demo) return; // no accounts in the demo: Sign out is shown, greyed out
    onClose();
    try {
      await (await import('../store/vault')).signOut(user?.id);
    } catch {
      toast(t('app.signout_failed'), 'error'); // the server couldn't be reached: the session is still live, so say so
    }
  };
  const themes: Theme[] = ['auto', 'light', 'dark'];
  return (
    <>
      <div class="menu-scrim dim" onClick={onClose} aria-hidden="true" />
      <div class="menu-pop acct-menu" id="account-menu" role="group" aria-label={t('app.account_label')} ref={ref}>
        {user && <div class="who"><b>{user.username}</b><small>{t(user.role === 'owner' ? 'people.owner' : 'people.member')}</small></div>}
        <button class="mi" onClick={go('/')}><Icon name="plus" size="sm" />{t('app.menu_new')}</button>
        <button class="mi" onClick={go('/links')}><Icon name="link" size="sm" />{t('app.nav_links')}</button>
        {user?.role === 'owner' && <button class="mi" onClick={go('/server')}><Icon name="gauge" size="sm" />{t('app.nav_server')}</button>}
        {user && <button class="mi" onClick={go('/account')}><Icon name="user" size="sm" />{t('app.menu_account')}</button>}
        <hr />
        <span class="lbl" id="theme-label">{t('app.menu_theme')}</span>
        <div class="theme" role="radiogroup" aria-labelledby="theme-label" onKeyDown={arrowSelect}>
          {themes.map((x) => (
            <button key={x} role="radio" aria-checked={theme.value === x} tabIndex={theme.value === x ? 0 : -1} class={theme.value === x ? 'on' : ''} onClick={() => setTheme(x)}>
              {t(`app.theme_${x}`)}
            </button>
          ))}
        </div>
        {user ? <><hr /><button class="mi" onClick={signOut} aria-disabled={c?.demo || undefined} title={c?.demo ? t('policy.not_in_demo') : undefined}><Icon name="logout" size="sm" />{t('app.menu_signout')}</button></>
          : c?.features.sign_in && <><hr /><button class="mi" onClick={go('/signin')}><Icon name="user" size="sm" />{t('app.nav_signin')}</button></>}
      </div>
    </>
  );
}

/** "N of M links left today · resets in 7 h" in the demo: plain in the DEMO chip's popover, a pill in its colours on Your links. */
export function DemoQuota({ pill }: { pill?: boolean }) {
  const q = config.value?.demo ? config.value.quota : undefined;
  if (!q) return null;
  const left = Math.max(0, q.limit - q.used);
  const reset = q.reset_at ? (Date.parse(q.reset_at) - Date.now()) / 1000 : 0;
  return (
    <span class={`demo-quota${pill ? ' pill' : ''}${left === 0 ? ' out' : ''}`}>
      <span class="q-meter" aria-hidden="true"><i style={`width:${(left / Math.max(1, q.limit)) * 100}%`} /></span>
      <span><span>{t('demo.quota', { left, limit: q.limit })}</span>{reset > 0 && <> · <span>{t('demo.resets_in', { duration: shortDuration(Math.max(60, reset)) })}</span></>}</span>
    </span>
  );
}

/** Senders see a small "Demo" badge by the brand instead of a bar; it opens what the demo means and today's quota. */
function DemoChip() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: MouseEvent) => !(e.target as Element).closest('.demo-wrap') && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  return (
    <div class="has-pop demo-wrap">
      <button type="button" class="demo-chip" aria-expanded={open} aria-controls="demo-pop" title={t('demo.about')} onClick={() => setOpen(!open)}>{t('demo.chip')}</button>
      {open && (
        <div class="menu-pop demo-pop" id="demo-pop" role="note">
          <p>{rich('demo.banner_marked', { lead: <b>{t('demo.banner_lead')}</b> })}</p>
          <DemoQuota />
        </div>
      )}
    </div>
  );
}

/** The dots between the parts are drawn by CSS (.dot): on phones the parts stack, and no line starts or ends with one. */
export function Footer() {
  return (
    <footer class="ft">
      <span class="ft-i"><span>{t('app.powered_by')}</span>
        <a class="ft-brand" href="https://github.com/polius/cryptex" rel="external noopener" target="_blank"><Mark /><b>cryptex</b></a></span>
      <span class="ft-i dot"><span>{t('app.e2e')}</span>{config.value?.demo && <span class="dot"><a href="/privacy">{t('privacy.title')}</a></span>}</span>
    </footer>
  );
}

/** How far up toasts sit so they never cover a bar pinned to the bottom of the screen (a phone's action bar, the
 *  Server tab's unsaved changes): measured while a toast shows, as scrolling moves a sticky bar. */
function useToastLift(on: boolean): number | undefined {
  const [lift, setLift] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!on) return setLift(undefined);
    let frame = 0;
    const measure = () => {
      frame = 0;
      let top = innerHeight;
      for (const bar of document.querySelectorAll<HTMLElement>('.actions-m, .savebar')) {
        const pos = getComputedStyle(bar).position;
        const r = bar.getBoundingClientRect();
        if ((pos === 'sticky' || pos === 'fixed') && r.height && r.top < innerHeight && r.bottom > 0) top = Math.min(top, r.top);
      }
      setLift(top < innerHeight ? innerHeight - top + 12 : undefined);
    };
    const later = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    addEventListener('scroll', later, { passive: true });
    addEventListener('resize', later);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener('scroll', later);
      removeEventListener('resize', later);
    };
  }, [on]);
  return lift;
}

export function Toasts() {
  const lift = useToastLift(toasts.value.length > 0);
  return (
    <div class="toasts" aria-live="polite" aria-atomic="false" style={lift ? { bottom: `max(${lift}px, var(--toast-b))` } : undefined}>
      {toasts.value.map((x) => (
        <div key={x.id} class={`toast ${x.kind}`} role={x.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={x.kind === 'error' ? 'alert' : x.kind === 'info' ? 'info' : 'check'} />
          <span>{x.text}</span>
          {x.kind === 'error' && <button class="btn icon sm ghost" aria-label={t('common.dismiss')} onClick={() => dismiss(x.id)}><Icon name="x" size="sm" /></button>}
        </div>
      ))}
    </div>
  );
}

/** "Skip to content" moves focus without touching the address: on a link page the fragment is the key, and a
 *  revealed secret must survive it. */
function skip(e: MouseEvent) {
  e.preventDefault();
  const main = document.getElementById('main');
  if (!main) return;
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  main.focus();
}

export function Page({ children, header }: { children: ComponentChildren; header: ComponentChildren }) {
  return (
    <>
      <a class="skip" href="#main" onClick={skip}>{t('app.skip')}</a>
      {header}
      {children}
      <Footer />
    </>
  );
}
