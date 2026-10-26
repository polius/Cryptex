/** A tiny history router. Fragments are read once on load and kept in memory (frontend.md §1). */
import { signal } from '@preact/signals';

export interface Location {
  path: string;
  query: URLSearchParams;
  hash: string;
}

const read = (): Location => ({ path: location.pathname, query: new URLSearchParams(location.search), hash: location.hash.slice(1) });

export const route = signal<Location>(read());

export function navigate(to: string, o: { replace?: boolean } = {}): void {
  if (o.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  route.value = read();
  window.scrollTo(0, 0);
}

/** Remove the key from the address bar after reveal, so it doesn't linger in history or screenshots. */
export function dropFragment(): void {
  history.replaceState(null, '', location.pathname + location.search);
}

window.addEventListener('popstate', () => {
  route.value = read();
});

/** A link pasted into the same tab only changes the fragment: start that page over with the new key. */
window.addEventListener('hashchange', () => {
  if (/^\/(s|q)\//.test(location.pathname)) location.reload();
});

/** Same-origin <a href> clicks navigate without a page load. */
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.('a');
  if (!a || a.target || a.hasAttribute('download') || a.getAttribute('rel')?.includes('external')) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/')) return;
  e.preventDefault();
  navigate(href);
});

export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const s = path.split('/');
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) out[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return out;
}
