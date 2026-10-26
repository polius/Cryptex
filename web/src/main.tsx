/** Router, theme and config bootstrap (frontend.md §1). */
import './styles/fonts.css';
import './styles/app.css';
import './styles/live.css';
import { render } from 'preact';
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { match, navigate, route } from './lib/router';
import { applyTheme, bootError, config, loadConfig } from './lib/state';
import { ReauthDialog } from './screens/server/common';
import { Toasts } from './ui/chrome';
import { ConfirmHost } from './ui/confirm';
import { t } from './lib/i18n';

applyTheme();

/** First focus on each route: the page heading, except "/" where it's the composer (frontend.md §6).
 *  Leaves focus alone if the person already moved it. */
function focusFirst(force = false): void {
  const active = document.activeElement;
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

const Reveal = lazy(() => import('./screens/reveal/Reveal').then((m) => m.Reveal));
const NotFoundBody = lazy(() => import('./screens/reveal/Reveal').then((m) => m.NotFoundBody));
const Respond = lazy(() => import('./screens/respond/Respond').then((m) => m.Respond));
const KeyImport = lazy(() => import('./screens/respond/Respond').then((m) => m.KeyImport));
const Home = lazy(() => import('./screens/Home').then((m) => m.Home));
const Links = lazy(() => import('./screens/links/Links').then((m) => m.Links));
const Receipt = lazy(() => import('./screens/links/Receipt').then((m) => m.Receipt));
const SignIn = lazy(() => import('./screens/auth/SignIn').then((m) => m.SignIn));
const Setup = lazy(() => import('./screens/auth/Setup').then((m) => m.Setup));
const DemoLimit = lazy(() => import('./screens/misc').then((m) => m.DemoLimit));
const Privacy = lazy(() => import('./screens/misc').then((m) => m.Privacy));
const MyTokens = lazy(() => import('./screens/server/Tokens').then((m) => m.MyTokens));
const TokensSection = lazy(() => import('./screens/server/Tokens').then((m) => m.TokensSection));
const OverviewSection = lazy(() => import('./screens/server/Sections').then((m) => m.OverviewSection));
const AccessSection = lazy(() => import('./screens/server/Sections').then((m) => m.AccessSection));
const LimitsSection = lazy(() => import('./screens/server/Sections').then((m) => m.LimitsSection));
const BrandingSection = lazy(() => import('./screens/server/Sections').then((m) => m.BrandingSection));
const NotificationsSection = lazy(() => import('./screens/server/Sections').then((m) => m.NotificationsSection));
const AuditSection = lazy(() => import('./screens/server/Sections').then((m) => m.AuditSection));

function Screen() {
  const c = config.value!;
  const { path } = route.value;
  let m: Record<string, string> | null;
  // Recipient routes work whatever the server's setup or access state.
  if ((m = match('/s/:id', path))) return <Reveal id={m.id} />;
  if ((m = match('/q/:id/key', path))) return <KeyImport id={m.id} />;
  if ((m = match('/q/:id', path))) return <Respond id={m.id} />;
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
  const mustSignIn = c.mode === 'signed_in' && !c.signed_in;
  if ((path === '/' || path === '/links') && mustSignIn) {
    navigate(`/signin?next=${encodeURIComponent(path)}`, { replace: true });
    return null;
  }
  if (path === '/') return <Home />;
  if (path === '/links') return <Links />;
  if ((m = match('/r/:id', path))) return <Receipt id={m.id} />;
  if (path === '/demo/limit' && c.demo) return <DemoLimit />;
  if (path === '/tokens' && c.signed_in && !c.demo) return <MyTokens />;
  if (path.startsWith('/server') && (c.user?.role === 'owner' && c.signed_in || c.demo)) {
    const section = path.slice('/server'.length) || '/';
    switch (section) {
      case '/': return <OverviewSection />;
      case '/access': return <AccessSection />;
      case '/limits': return <LimitsSection />;
      case '/branding': return <BrandingSection />;
      case '/notifications': return <NotificationsSection />;
      case '/tokens': return <TokensSection />;
      case '/audit': return <AuditSection />;
    }
  }
  return <NotFoundBody />;
}

function App() {
  const c = config.value;
  const path = route.value.path;
  useEffect(() => {
    requestAnimationFrame(() => focusFirst(true));
  }, [path, !!c]);
  if (bootError.value) {
    return (
      <main class="main narrow boot-error" id="main">
        <h1 class="h1">{bootError.value === 'unsupported' ? 'Update your browser' : 'Can’t reach this server'}</h1>
        <p class="lede">{bootError.value === 'unsupported' ? t('reveal.unsupported', { brand: 'Cryptex' }) : t('errors.internal')}</p>
        {bootError.value !== 'unsupported' && <button class="btn secondary" onClick={() => location.reload()}>{t('send.try_again')}</button>}
      </main>
    );
  }
  if (!c) return null;
  return (
    <>
      <Screen />
      <ReauthDialog />
      <ConfirmHost />
      <Toasts />
    </>
  );
}

async function boot() {
  const supported = !!(globalThis.crypto?.subtle && window.indexedDB && window.Worker && 'TextEncoder' in window);
  if (!supported) {
    bootError.value = 'unsupported';
  } else {
    try {
      await loadConfig();
      if (!/^\/(s|q)\//.test(location.pathname)) void import('./screens/links/sync').then((m) => m.refreshLinksCount());
    } catch {
      bootError.value = 'offline';
    }
  }
  const root = document.getElementById('app')!;
  root.textContent = '';
  render(<App />, root);
}

void boot();
