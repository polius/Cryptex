/** The strict CSP (no inline scripts or styles, no third parties) holds: no violations on any main screen. */
import { expect, test } from '@playwright/test';
import { owner, paste, sendText, stranger } from './helpers';

test('no Content-Security-Policy violations and no third-party requests', async ({ browser }) => {
  const { page } = await owner(browser);
  const violations: string[] = [];
  const foreign: string[] = [];
  const watch = (p: import('@playwright/test').Page) => {
    p.on('console', (m) => /Content Security Policy|Refused to/.test(m.text()) && violations.push(m.text()));
    p.on('request', (q) => !q.url().startsWith('http://localhost') && !q.url().startsWith('blob:') && !q.url().startsWith('data:') && foreign.push(q.url()));
  };
  watch(page);
  const res = await page.goto('/');
  expect(res?.headers()['content-security-policy']).toContain("default-src 'self'");
  await paste(page, 'DB_HOST=db\nDB_PASSWORD=x');
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  for (const path of ['/links', '/server', '/server/access', '/server/limits', '/server/branding', '/server/audit', '/privacy']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
  }
  const link = await sendText(page, 'csp canary', 'CSP');
  const r = await stranger(browser);
  watch(r.page);
  await r.page.goto(link);
  await r.page.getByRole('button', { name: 'Reveal secret' }).click();
  await expect(r.page.locator('.out')).toBeVisible();
  expect(violations).toEqual([]);
  expect(foreign).toEqual([]);
});
