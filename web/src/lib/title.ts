import { t } from './i18n';

/** The tab's title for a route (M4): "{page} · {brand}". A link's page says what it is in fixed words, never the
 *  sender's title. */
export function pageTitle(path: string, brand: string): string {
  const server: Record<string, string> = { '': 'server.overview', '/': 'server.overview', '/access': 'server.access', '/limits': 'server.limits', '/branding': 'server.branding', '/audit': 'server.audit' };
  const fixed: Record<string, string> = {
    '/': 'app.nav_new', '/links': 'app.nav_links', '/signin': 'app.nav_signin', '/setup': 'titles.setup', '/invite': 'titles.invite',
    '/reset': 'titles.reset', '/account': 'app.menu_account', '/privacy': 'titles.privacy', '/demo/limit': 'titles.demo',
  };
  const key = path.startsWith('/s/') ? 'titles.sealed' : path.startsWith('/a/') ? 'titles.request' : path.startsWith('/r/') ? 'titles.link' : fixed[path];
  const page = path.startsWith('/server') && server[path.slice('/server'.length)] !== undefined
    ? t('titles.server', { section: t(server[path.slice('/server'.length)]) }) : key ? t(key) : null;
  return page ? t('titles.page', { page, brand }) : brand;
}
