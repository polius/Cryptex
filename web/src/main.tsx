/** Router, theme and config bootstrap. */
import './styles/fonts.css';
import './styles/app.css';
import './styles/live.css';
import { render } from 'preact';
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { isId, match, navigate, route } from './lib/router';
import { applyTheme, bootError, config, countLinks, loadConfig } from './lib/state';
import { ReauthDialog } from './screens/server/common';
import { Toasts } from './ui/chrome';
import { ConfirmHost } from './ui/confirm';
import { t } from './lib/i18n';

applyTheme();
// Phones and tablets, iPads included (they report a Mac, and a fine pointer with a trackpad): no "drop files" hints.
if (/iPad|iPhone|iPod|Android/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  document.documentElement.classList.add('touch-os');
}

/** First focus on each route: the page heading, except "/" where it's the composer.
 *  Leaves focus alone if the person already moved it. */
function focusFirst(force = false): void {
  const active = document.activeElement;
  if (active?.closest('[aria-modal="true"]')) return; // an open dialog keeps focus (a prompt that loaded meanwhile)
  if (!force && active && active !== document.body && active.closest('main')) return;
  if (location.pathname === '/') (document.getElementById('composer') ?? document.querySelector<HTMLElement>('[data-autofocus]'))?.focus({ preventScroll: true });
  else document.querySelector<HTMLElement>('[data-page-heading]')?.focus({ preventScroll: true });
}

/** Load a screen's code only when its route is used, so recipients download the reveal page and nothing else. */
function lazy<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  let C: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;
  return (props: P) => {
    const [, ready] = useState(0);
    if (C) return <C {...props} />;
    pending ??= load().then((c) => {
      C = c;
    });
    void pending.then(() => {
      ready((n) => n + 1);
      requestAnimationFrame(() => focusFirst()); // the screen arrived after the route's first focus attempt
    });
    return null;
  };
}

// Only for signed-in people: unlock with the password, the reset-link notice.
const ResetNotice = lazy(() => import('./ui/notice').then((m) => m.ResetNotice));
const VaultPrompts = lazy(() => import('./ui/vault').then((m) => m.VaultPrompts));
const Reveal = lazy(() => import('./screens/reveal/Reveal').then((m) => m.Reveal));
const NotFoundBody = lazy(() => import('./screens/reveal/Reveal').then((m) => m.NotFoundBody));
const Home = lazy(() => import('./screens/Home').then((m) => m.Home));
const Account = lazy(() => import('./screens/Account').then((m) => m.Account));
const Links = lazy(() => import('./screens/links/Links').then((m) => m.Links));
const Receipt = lazy(() => import('./screens/links/Receipt').then((m) => m.Receipt));
const Answer = lazy(() => import('./screens/request/Answer').then((m) => m.Answer));
const SignIn = lazy(() => import('./screens/auth/SignIn').then((m) => m.SignIn));
const Setup = lazy(() => import('./screens/auth/Setup').then((m) => m.Setup));
const Reset = lazy(() => import('./screens/auth/Reset').then((m) => m.Reset));
const Invite = lazy(() => import('./screens/auth/Invite').then((m) => m.Invite));
const DemoLimit = lazy(() => import('./screens/misc').then((m) => m.DemoLimit));
const Privacy = lazy(() => import('./screens/misc').then((m) => m.Privacy));
const OverviewSection = lazy(() => import('./screens/server/Sections').then((m) => m.OverviewSection));
const AccessSection = lazy(() => import('./screens/server/Sections').then((m) => m.AccessSection));
const LimitsSection = lazy(() => import('./screens/server/Sections').then((m) => m.LimitsSection));
const BrandingSection = lazy(() => import('./screens/server/Sections').then((m) => m.BrandingSection));
const AuditSection = lazy(() => import('./screens/server/Sections').then((m) => m.AuditSection));

function Screen() {
  const c = config.value!;
  const { path } = route.value;
  let m: Record<string, string> | null;
  // Recipient routes work whatever the server's setup or access state.
  if ((m = match('/s/:id', path))) return isId(m.id) ? <Reveal id={m.id} /> : <NotFoundBody />;
  if ((m = match('/a/:id', path))) return isId(m.id) ? <Answer id={m.id} /> : <NotFoundBody />;
  if (path === '/privacy') return <Privacy />;
  if (c.setup_needed) {
    if (path !== '/setup') {
      navigate('/setup', { replace: true });
      return null;
    }
    return <Setup />;
  }
  if (path === '/setup') {
    navigate('/', { replace: true });
    return null;
  }
  if (path === '/signin') return <SignIn />;
  if (path === '/invite') return <Invite />;
  if (path === '/reset') return <Reset />;
  const mustSignIn = c.mode === 'signed_in' && !c.signed_in;
  if ((path === '/' || path === '/links') && mustSignIn) {
    navigate(`/signin?next=${encodeURIComponent(path)}`, { replace: true });
    return null;
  }
  if (path === '/account' && !c.signed_in && !c.demo) {
    navigate('/signin?next=%2Faccount', { replace: true });
    return null;
  }
  if (path === '/account') return <Account />;
  if (path === '/') return <Home />;
  if (path === '/links') return <Links />;
  if ((m = match('/r/:id', path))) return isId(m.id) ? <Receipt id={m.id} /> : <NotFoundBody />;
  if (path === '/demo/limit' && c.demo) return <DemoLimit />;
  if (path.startsWith('/server') && (c.user?.role === 'owner' && c.signed_in || c.demo)) {
    const section = path.slice('/server'.length) || '/';
    switch (section) {
      case '/': return <OverviewSection />;
      case '/access': return <AccessSection />;
      case '/limits': return <LimitsSection />;
      case '/branding': return <BrandingSection />;
      case '/audit': return <AuditSection />;
    }
  }
  return <NotFoundBody />;
}

const SIGN_IN_PAGES = new Set(['/signin', '/setup', '/invite', '/reset']);

const BOOT_TITLE: Record<string, string> = { unsupported: 'boot.unsupported_title', insecure: 'boot.insecure_title' };

function App() {
  const c = config.value;
  const path = route.value.path;
  useEffect(() => {
    requestAnimationFrame(() => focusFirst(true));
  }, [path, !!c]);
  if (bootError.value) {
    return (
      <main class="main narrow boot-error" id="main">
        <h1 class="h1">{t(BOOT_TITLE[bootError.value] ?? 'boot.offline_title')}</h1>
        <p class="lede">{bootError.value === 'unsupported' ? t('reveal.unsupported', { brand: 'Cryptex' }) : bootError.value === 'insecure' ? t('boot.insecure_body') : t('errors.internal')}</p>
        {bootError.value === 'offline' && <button class="btn secondary" onClick={() => location.reload()}>{t('send.try_again')}</button>}
      </main>
    );
  }
  if (!c) return null;
  // A link someone sent (a secret, or a request to answer) is about the recipient, not the account signed in here: no
  // account prompts over it. Nor on
  // the pages that sign someone in (maybe someone else): unlocking or the reset notice would ask for the password
  // being replaced there, or cancel the very link in use.
  const account = c.signed_in && !path.startsWith('/s/') && !path.startsWith('/a/') && !SIGN_IN_PAGES.has(path);
  return (
    <>
      <Screen />
      {account && <VaultPrompts />}
      {account && c.user?.notice && <ResetNotice />}
      <ReauthDialog />
      <ConfirmHost />
      <Toasts />
    </>
  );
}

async function boot() {
  const supported = !!(globalThis.crypto?.subtle && window.indexedDB && window.Worker && 'TextEncoder' in window);
  // Plain http (other than localhost) has no crypto.subtle: that's the server's setup, not an old browser.
  if (!window.isSecureContext) {
    bootError.value = 'insecure';
  } else if (!supported) {
    bootError.value = 'unsupported';
  } else {
    try {
      await loadConfig();
      if (!location.pathname.startsWith('/s/') && !location.pathname.startsWith('/a/')) countLinks();
    } catch {
      bootError.value = 'offline';
    }
  }
  const root = document.getElementById('app')!;
  root.textContent = '';
  render(<App />, root);
}

void boot();
