/** Router, theme and config bootstrap (frontend.md §1). */
import './styles/fonts.css';
import './styles/app.css';
import './styles/live.css';
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { match, navigate, route } from './lib/router';
import { applyTheme, bootError, config, loadConfig } from './lib/state';
import { refreshLinksCount } from './screens/links/sync';
import { SignIn } from './screens/auth/SignIn';
import { Setup } from './screens/auth/Setup';
import { Home } from './screens/Home';
import { Links } from './screens/links/Links';
import { Receipt } from './screens/links/Receipt';
import { DemoLimit, Privacy } from './screens/misc';
import { KeyImport, Respond } from './screens/respond/Respond';
import { NotFoundBody, Reveal } from './screens/reveal/Reveal';
import { ReauthDialog } from './screens/server/common';
import { AccessSection, AuditSection, BrandingSection, LimitsSection, NotificationsSection, OverviewSection } from './screens/server/Sections';
import { MyTokens, TokensSection } from './screens/server/Tokens';
import { Toasts } from './ui/chrome';
import { t } from './lib/i18n';

applyTheme();

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
    // First focus on each route: the page heading, except "/" where it's the composer (frontend.md §6).
    requestAnimationFrame(() => {
      if (path === '/') (document.getElementById('composer') ?? document.querySelector<HTMLElement>('[data-autofocus]'))?.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('[data-page-heading]')?.focus({ preventScroll: true });
    });
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
      void refreshLinksCount();
    } catch {
      bootError.value = 'offline';
    }
  }
  const root = document.getElementById('app')!;
  root.textContent = '';
  render(<App />, root);
}

void boot();
