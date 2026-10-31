/** G2 demo limit, privacy notice, and the not-found page for unknown routes. */
import { useEffect, useState } from 'preact/hooks';
import { shortDuration } from '../lib/format';
import { rich, t } from '../lib/i18n';
import { navigate } from '../lib/router';
import { cfg, loadConfig } from '../lib/state';
import { H1, useTick } from '../ui/bits';
import { AppHeader, host, Page } from '../ui/chrome';
import { Icon } from '../ui/icons';

const SETUP_GUIDE = 'https://github.com/polius/cryptex#run-it';

export function DemoLimit() {
  useTick(30_000);
  const c = cfg();
  // The quota as the server counts it now: the send that led here used it up, or nothing did (a visit by address).
  const [fresh, setFresh] = useState(false);
  useEffect(() => void loadConfig().catch(() => undefined).finally(() => setFresh(true)), []);
  const usedUp = !c.quota || c.quota.used >= c.quota.limit;
  if (!usedUp && fresh) {
    navigate('/', { replace: true });
    return null;
  }
  if (!usedUp) return <Page header={<AppHeader />}><main class="main" id="main" aria-busy="true" /></Page>;
  const reset = c.quota?.reset_at ? (Date.parse(c.quota.reset_at) - Date.now()) / 1000 : 0;
  return (
    <Page header={<AppHeader />}>
      <main class="main" id="main" style="padding-top:72px">
        <span class="avatar big warn" aria-hidden="true"><Icon name="hourglass" size="lg" /></span>
        <H1>{t('demo.limit_title', { limit: c.quota?.limit ?? 10 })}</H1>
        <p class="lede">{rich('demo.limit_body', { duration: <b>{shortDuration(Math.max(60, reset))}</b> })}</p>
        <div class="card"><div class="card-b stack">
          <h2 class="h3">{t('demo.self_host')}</h2>
          <p class="muted small">{t('demo.self_host_body')}</p>
          {/* The README has the one setup that's right (HTTPS proxy, TRUSTED_PROXIES): no shortcut command here. */}
          <a class="btn secondary" style="justify-self:start" href={SETUP_GUIDE} rel="external noopener" target="_blank"><Icon name="arrow" size="sm" />{t('demo.setup_guide')}</a>
        </div></div>
      </main>
    </Page>
  );
}

export function Privacy() {
  const c = cfg();
  const rows = ['secret', 'gone', 'events', 'account', 'totp', 'vault', 'temp', 'cookie'];
  return (
    <Page header={<AppHeader />}>
      <main class="main prose" id="main">
        <H1>{t('privacy.title')}</H1>
        <p class="lede">{rich(c.brand.name ? 'privacy.lede' : 'privacy.lede_no_brand', { brand: c.brand.name, host: <span class="mono">{host()}</span> })}</p>
        <h2 class="h3">{t('privacy.cant_see_title')}</h2>
        <p>{rich('privacy.cant_see_body', { hash: <span class="mono">#</span> })}</p>
        <h2 class="h3">{t('privacy.store_title')}</h2>
        <div class="table-wrap"><table class="table resp">
          <thead><tr><th>{t('privacy.col_data')}</th><th>{t('privacy.col_why')}</th><th>{t('privacy.col_kept')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r}><td>{t(`privacy.row_${r}`)}</td><td data-label={t('privacy.col_why')}>{t(`privacy.row_${r}_why`)}</td><td data-label={t('privacy.col_kept')}>{t(`privacy.row_${r}_kept`)}</td></tr>
            ))}
          </tbody>
        </table></div>
        <p>{t('privacy.no_tracking')}</p>
        <h2 class="h3">{t('privacy.limit_title')}</h2>
        <p>{t('privacy.limit_body')}</p>
        {c.demo && <><h2 class="h3">{t('privacy.demo_title')}</h2><p>{t('privacy.demo_body')}</p></>}
      </main>
    </Page>
  );
}
