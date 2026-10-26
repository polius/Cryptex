/** Page chrome: brand, headers, account menu, demo bar, footer, toasts. */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { api, setCsrf } from '../api/client';
import { initials } from '../lib/format';
import { t } from '../lib/i18n';
import { navigate, route } from '../lib/router';
import { config, dismiss, linksCount, loadConfig, setTheme, theme, toast, toasts, type Theme } from '../lib/state';
import { clearDevice } from '../store/db';
import { confirmDialog } from './confirm';
import { useFocusTrap } from './dialog';
import { Icon, Mark } from './icons';

export function Brand({ sub = true, href = '/' }: { sub?: boolean; href?: string }) {
  const c = config.value;
  const name = c?.brand.name;
  if (!name) {
    return <a class="brand" href={href} aria-label="Cryptex home"><Mark /><span class="wordmark">cryptex</span></a>;
  }
  return (
    <a class="brand" href={href} aria-label={`${name} ${t('app.brand_suffix')}`}>
      {c?.brand.logo_url ? <img class="op-logo img" src={c.brand.logo_url} alt="" /> : <span class="op-logo" aria-hidden="true">{name.trim()[0]?.toUpperCase()}</span>}
      <span class="op-name">{name}</span>
      {sub && <span class="op-sub">{t('app.brand_suffix')}</span>}
    </a>
  );
}

export function host(): string {
  try {
    return new URL(config.value?.brand.public_url || location.origin).host;
  } catch {
    return location.host;
  }
}

/** Recipient and responder pages: brand plus the address with a lock, nothing to click away to. */
export function RecipientHeader() {
  return (
    <header class="hd">
      <Brand />
      <span class="sp" />
      <span class="domain" title="The address of this page"><Icon name="lock" />{host()}</span>
    </header>
  );
}

export function AppHeader({ active }: { active?: 'new' | 'links' | 'server' }) {
  const c = config.value;
  const user = c?.user && c.signed_in ? c.user : null;
  const owner = user?.role === 'owner' || c?.demo;
  const [open, setOpen] = useState(false);
  const canSend = !!user || c?.mode === 'anyone';
  return (
    <header class="hd">
      <Brand />
      <span class="sp" />
      <nav aria-label="Main">
        {canSend && <a class={`navlink hide-m${active === 'new' ? ' on' : ''}`} href="/" aria-current={active === 'new' ? 'page' : undefined}><Icon name="plus" size="sm" />{t('app.nav_new')}</a>}
        {canSend && (
          <a class={`navlink${active === 'links' ? ' on' : ''}`} href="/links" aria-current={active === 'links' ? 'page' : undefined}>
            {t('app.nav_links')}{linksCount.value > 0 && <span class="count" aria-label={`${linksCount.value} waiting`}>{linksCount.value}</span>}
          </a>
        )}
        {owner && <a class={`navlink hide-m${active === 'server' ? ' on' : ''}`} href="/server" aria-current={active === 'server' ? 'page' : undefined}><Icon name="gauge" size="sm" />{t('app.nav_server')}</a>}
        {!user && !canSend && route.value.path !== '/signin' && <a class="navlink" href="/signin">{t('app.nav_signin')}</a>}
      </nav>
      <div class="has-pop">
        <button class={user ? 'avatar' : 'avatar anon'} aria-label="Account menu" aria-haspopup="menu" aria-expanded={open} title={user?.name || user?.email || 'Menu'}
          onClick={() => setOpen(!open)} id="account-button">
          {user ? initials(user.name, user.email) : <Icon name="user" size="sm" />}
        </button>
        {open && <AccountMenu onClose={() => setOpen(false)} />}
      </div>
    </header>
  );
}

function AccountMenu({ onClose }: { onClose: () => void }) {
  const c = config.value;
  const user = c?.user && c.signed_in ? c.user : null;
  const ref = useFocusTrap(true, onClose);
  const go = (to: string) => () => {
    onClose();
    navigate(to);
  };
  const signOut = async () => {
    onClose();
    await api('POST', '/auth/logout').catch(() => undefined);
    setCsrf(null);
    await loadConfig();
    navigate('/');
  };
  const clear = async () => {
    onClose();
    if (!(await confirmDialog({ title: 'Clear this device?', body: 'Your links, saved link keys and request keys are removed from this browser. Secrets on the server aren’t affected, and answers to your requests can’t be opened here anymore.', confirm: 'Clear this device', danger: true }))) return;
    await clearDevice();
    linksCount.value = 0;
    onClose();
    toast('This device was cleared');
    navigate('/');
  };
  const themes: Theme[] = ['auto', 'light', 'dark'];
  return (
    <>
      <div class="menu-scrim" onClick={onClose} aria-hidden="true" />
      <div class="menu-pop" role="menu" aria-label="Account" ref={ref}>
        {user && <div class="who"><b>{user.name || user.email}</b><small>{user.email} · {user.role}</small></div>}
        <button class="mi" role="menuitem" onClick={go('/')}><Icon name="plus" size="sm" />New secret</button>
        <button class="mi" role="menuitem" onClick={go('/links')}><Icon name="link" size="sm" />{t('app.nav_links')}</button>
        {user && !c?.demo && <button class="mi" role="menuitem" onClick={go('/tokens')}><Icon name="terminal" size="sm" />API tokens</button>}
        {(user?.role === 'owner' || c?.demo) && <button class="mi" role="menuitem" onClick={go('/server')}><Icon name="gauge" size="sm" />{t('app.nav_server')}</button>}
        <hr />
        <span class="lbl" id="theme-label">{t('app.menu_theme')}</span>
        <div class="theme" role="radiogroup" aria-labelledby="theme-label">
          {themes.map((x) => (
            <button key={x} role="radio" aria-checked={theme.value === x} class={theme.value === x ? 'on' : ''} onClick={() => setTheme(x)}>
              {t(`app.theme_${x}`)}
            </button>
          ))}
        </div>
        <hr />
        <button class="mi" role="menuitem" onClick={clear}><Icon name="trash" size="sm" />{t('app.menu_clear_device')}</button>
        {user ? <button class="mi" role="menuitem" onClick={signOut}><Icon name="logout" size="sm" />{t('app.menu_signout')}</button>
          : !c?.demo && (c?.features.sso || c?.features.password_sign_in) && <button class="mi" role="menuitem" onClick={go('/signin')}><Icon name="user" size="sm" />{t('app.nav_signin')}</button>}
      </div>
    </>
  );
}

export function DemoBar({ recipient = false }: { recipient?: boolean }) {
  if (!config.value?.demo) return null;
  return (
    <div class="demo-bar" role="note">
      <Icon name="info" size="sm" />
      <span>{recipient ? t('demo.recipient_banner') : <><b>Public demo.</b> {t('demo.banner').replace(/^Public demo\.\s*/, '')}</>}</span>
    </div>
  );
}

export function Footer() {
  return (
    <footer class="ft">
      <span>{t('app.powered_by')}</span>
      <a class="ft-brand" href="https://github.com/polius/cryptex" rel="external noopener" target="_blank"><Mark /><b>cryptex</b></a>
      <span aria-hidden="true">·</span>
      <span>{t('app.e2e')}</span>
      {config.value?.demo && <><span aria-hidden="true">·</span><a href="/privacy">Privacy</a></>}
    </footer>
  );
}

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite" aria-atomic="false">
      {toasts.value.map((x) => (
        <div key={x.id} class={`toast ${x.kind}`} role={x.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={x.kind === 'error' ? 'alert' : x.kind === 'info' ? 'info' : 'check'} />
          <span>{x.text}</span>
          {x.kind === 'error' && <button class="btn icon sm ghost" aria-label="Dismiss" onClick={() => dismiss(x.id)}><Icon name="x" size="sm" /></button>}
        </div>
      ))}
    </div>
  );
}

export function Page({ children, header, demoRecipient }: { children: ComponentChildren; header: ComponentChildren; demoRecipient?: boolean }) {
  return (
    <>
      <a class="skip" href="#main">{t('app.skip')}</a>
      <DemoBar recipient={demoRecipient} />
      {header}
      {children}
      <Footer />
    </>
  );
}
