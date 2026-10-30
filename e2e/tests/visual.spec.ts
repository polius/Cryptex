/**
 * Visual regression (CX-91): every main screen (setup, invites, reset links and Your account included) at 1440 px and 390 px, light and dark, compared with
 * approved baselines in __screenshots__. Values that change per run
 * (IDs, keys, times, counts) are masked. Update with: PW_ARGS="--project=visual --update-snapshots".
 */
import { expect, test, type Page } from '@playwright/test';
import { OWNER } from '../global-setup';
import { createLink, fake, fakeFreshServer, FIXED_TOTP, owner, paste, sendText, stranger } from './helpers';

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;
const THEMES = ['light', 'dark'] as const;

async function snap(page: Page, name: string, mask: string[] = [], clipHeight?: number) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  // The header's link count changes as other tests run, and its width moves the header: hidden, not just masked.
  // (Set on the element: the app's CSP refuses an injected <style>.)
  await page.evaluate(() => document.querySelectorAll<HTMLElement>('.hd a[href="/links"] .count').forEach((el) => { el.style.display = 'none'; }));
  await page.waitForTimeout(150);
  // Phones: what fits on screen (sticky action bars make full-page captures misleading). Desktop: the whole page.
  const mobile = page.viewportSize()!.width < 720;
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: !clipHeight && !mobile,
    ...(clipHeight ? { clip: { x: 0, y: 0, width: page.viewportSize()!.width, height: clipHeight } } : {}),
    mask: [page.locator('.toasts'), page.locator('.hd a[href="/links"]'), ...mask.map((m) => page.locator(m))],
  });
}

for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
  for (const theme of THEMES) {
    test.describe(`${vp} ${theme}`, () => {
      const opts = { viewport, colorScheme: theme, deviceScaleFactor: vp === 'mobile' ? 2 : 1, isMobile: vp === 'mobile', hasTouch: vp === 'mobile' } as const;
      const tag = `${vp}-${theme}`;

      test('send', async ({ browser }) => {
        const { page } = await owner(browser, opts);
        await page.goto('/');
        await snap(page, `send-empty-${tag}`, ['.count']);
        await paste(page, 'DB_HOST=db-staging.internal:5432\nDB_USER=app_rw\nDB_PASSWORD="k7#Qp2-vR9mL"');
        await page.locator('.cmp-title input').fill('Staging database');
        await page.locator('.cmp-title input').blur();
        await snap(page, `send-filled-${tag}`, ['.count']);
        await page.getByRole('button', { name: 'Change', exact: true }).click();
        await snap(page, `send-options-${tag}`, ['.count']);
        await page.getByRole('button', { name: 'Done', exact: true }).first().click();
        await createLink(page);
        // The expiry date's length (2:09 or 10:09) moves its line breaks on phones: a fixed one instead.
        await page.locator('.facts > div:nth-child(2)').evaluate((el) => {
          el.querySelector('b')!.textContent = 'Fri, Oct 30, 10:09 AM';
          el.querySelector('span')!.textContent = 'in 1 day';
        });
        await snap(page, `send-sent-${tag}`,['.count', '.linkbox .url', '.facts > div:nth-child(2)']);
      });

      test('reveal', async ({ browser }) => {
        const { page } = await owner(browser);
        const link = await sendText(page, 'db-staging.internal:5432', 'Staging database');
        const r = await stranger(browser, opts);
        await r.page.goto(link);
        await expect(r.page.getByRole('button', { name: 'Reveal secret' })).toBeVisible();
        await snap(r.page, `reveal-sealed-${tag}`, ['.list li:nth-child(3)', '.fine .mono']);
        await r.page.getByRole('button', { name: 'Reveal secret' }).click();
        await expect(r.page.locator('.out')).toBeVisible();
        await snap(r.page, `reveal-open-${tag}`, ['.timer']);
        const g = await stranger(browser, opts);
        await g.page.goto(link);
        await expect(g.page.locator('h1')).toBeVisible();
        // The heading holds the open time, and its length moves the line breaks on phones: a fixed one instead.
        await g.page.locator('h1').evaluate((el) => { el.textContent = 'This secret was opened on Thu, Oct 29, 08:41 AM'; });
        await snap(g.page, `reveal-gone-${tag}`);
        // A new fragment alone is a same-document navigation the app ignores (router.ts): load the cut link afresh.
        await g.page.goto('about:blank');
        await g.page.goto(link.slice(0, link.indexOf('#') + 6));
        await expect(g.page.locator('.broken-url')).toBeVisible();
        await snap(g.page, `reveal-broken-${tag}`, ['.broken-url']);
        await g.page.goto('/no/such/page');
        await snap(g.page, `not-found-${tag}`);
      });

      test('your links and server', async ({ browser }) => {
        const { page } = await owner(browser, opts);
        await page.goto('/links');
        await expect(page.locator('.rows')).toBeVisible();
        await snap(page, `links-${tag}`, ['.count', '.tabs'], vp === 'mobile' ? 330 : 250); // heading and tabs only: the list grows as other tests run
        for (const s of ['access', 'limits', 'branding']) {
          await page.goto(`/server/${s}`);
          await expect(page.locator('.srv-main h1')).toBeVisible();
          // People change as other tests run: on Access only the top (who can create links, the People header) is compared.
          await snap(page, `server-${s}-${tag}`, ['.count', '.metric', 'td.mono', '.k small', 'table'], s === 'access' && vp === 'desktop' ? 600 : undefined);
        }
        await page.goto('/server');
        await expect(page.locator('.health')).toBeVisible();
        // Only the stable top: what needs attention depends on the host (disk, invites), so it isn't pixel-tested. On
        // phones the metrics stack and their wrapped values change their height, so the clip stops above them.
        await snap(page, `server-overview-${tag}`, ['.count', '.lede', '.metric'], vp === 'mobile' ? 210 : 330);
      });

      // Screens that need a state the shared e2e server isn't in (a fresh server, a live invite or reset link) answer
      // from faked API routes with fixed values, so nothing on them changes between runs.
      test('setup', async ({ browser }) => {
        const s = await stranger(browser, opts);
        await fakeFreshServer(s.page);
        await fake(s.page, '/setup/check', 204);
        await s.page.goto('/setup');
        await expect(s.page.getByLabel('Setup code')).toBeVisible();
        await snap(s.page, `setup-owner-${tag}`);
        await s.page.getByLabel('Setup code').fill('E2E-SETUP-CODE');
        await s.page.getByLabel('Username', { exact: true }).fill('lisa');
        await s.page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
        await s.page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(s.page.getByRole('heading', { name: 'What should recipients see?' })).toBeVisible();
        for (let i = 0; i < 2; i++) await s.page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(s.page.getByRole('heading', { name: 'Review and finish' })).toBeVisible();
        await snap(s.page, `setup-review-${tag}`);
      });

      test('invite and reset links', async ({ browser }) => {
        const s = await stranger(browser, opts);
        await fake(s.page, '/auth/invite', 200, { username: 'lisa', role: 'member', reset: false, ...FIXED_TOTP });
        await s.page.goto('/invite#an-invite-token');
        await expect(s.page.getByRole('heading', { name: 'Welcome, lisa' })).toBeVisible();
        await expect(s.page.locator('.qrbox svg')).toBeVisible();
        await snap(s.page, `invite-${tag}`);
        await fake(s.page, '/auth/reset', 200, { username: 'lisa', by: 'sam', expires_at: '2030-01-01T12:00:00Z', tries_left: 5, ...FIXED_TOTP });
        await s.page.goto('/reset#a-reset-token');
        await expect(s.page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
        await expect(s.page.locator('.qrbox svg')).toBeVisible();
        await snap(s.page, `reset-${tag}`);
      });

      test('your account and turning on 2FA', async ({ browser }) => {
        const { page } = await owner(browser, opts);
        await page.goto('/account');
        await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
        await snap(page, `account-${tag}`, ['.count']);
        // The authenticator dialog: 2FA shown as off, and a fixed key (the real one would need a fresh identity check).
        await page.route('**/api/v1/config', async (route) => {
          const res = await route.fetch();
          const c = await res.json();
          await route.fulfill({ response: res, json: { ...c, user: { ...c.user, totp: false } } });
        });
        await fake(page, '/me/totp', 200, FIXED_TOTP, 'POST');
        await page.reload();
        await page.getByRole('button', { name: 'Turn on 2FA' }).click();
        await expect(page.getByRole('dialog').locator('.qrbox svg')).toBeVisible();
        await snap(page, `account-totp-${tag}`, ['.count']);
      });

      test('the 2FA step of signing in', async ({ browser }) => {
        const s = await stranger(browser, opts);
        await s.page.goto('/signin');
        await s.page.getByLabel('Username', { exact: true }).fill(OWNER.username);
        await s.page.getByLabel('Password', { exact: true }).fill(OWNER.password);
        await s.page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(s.page.getByLabel('2FA code')).toBeVisible({ timeout: 15_000 });
        await snap(s.page, `signin-2fa-${tag}`);
      });

      test('sign in and empty links', async ({ browser }) => {
        const s = await stranger(browser, opts);
        await s.page.goto('/signin');
        await snap(s.page, `signin-${tag}`);
        await s.page.goto('/links');
        await expect(s.page.getByRole('heading', { name: 'Nothing sent yet' })).toBeVisible();
        await snap(s.page, `links-empty-${tag}`);
      });
    });
  }
}
