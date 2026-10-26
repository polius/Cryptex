/** G2 demo limit, privacy notice, and the not-found page for unknown routes. */
import { shortDuration } from '../lib/format';
import { t } from '../lib/i18n';
import { cfg } from '../lib/state';
import { copyText, H1, useTick } from '../ui/bits';
import { AppHeader, host, Page } from '../ui/chrome';
import { Icon } from '../ui/icons';

export function DemoLimit() {
  useTick(30_000);
  const c = cfg();
  const reset = c.quota?.reset_at ? (Date.parse(c.quota.reset_at) - Date.now()) / 1000 : 0;
  const cmd = 'docker run -d -p 80:80 -v ./data:/data poliuscorp/cryptex:3';
  return (
    <Page header={<AppHeader />}>
      <main class="main narrow" id="main" style="padding-top:72px">
        <span class="avatar big warn" aria-hidden="true"><Icon name="hourglass" size="lg" /></span>
        <H1>{t('demo.limit_title', { limit: c.quota?.limit ?? 30 })}</H1>
        <p class="lede">The demo resets at 00:00 UTC, in <b>{shortDuration(Math.max(60, reset))}</b>. Links you already sent keep working until they expire.</p>
        <div class="card"><div class="card-b stack">
          <h2 class="h3">{t('demo.self_host')}</h2>
          <p class="muted small">{t('demo.self_host_body')}</p>
          <div class="terminal">{cmd}</div>
          <button class="btn secondary" style="justify-self:start" onClick={() => copyText(cmd)}><Icon name="copy" size="sm" />{t('demo.copy_command')}</button>
        </div></div>
      </main>
    </Page>
  );
}

export function Privacy() {
  const c = cfg();
  const brand = c.brand.name || 'The operator of this server';
  return (
    <Page header={<AppHeader />}>
      <main class="main prose" id="main">
        <H1>Privacy</H1>
        <p class="lede">{brand} runs this Cryptex server at <span class="mono">{host()}</span> so people can send and request secrets, such as passwords and files, through one-time links.</p>
        <h2 class="h3">What we can’t see</h2>
        <p>Secrets are encrypted in your browser before they’re uploaded. The key is in the part of the link after <span class="mono">#</span>, which browsers don’t send to us. We can’t read what you send, its title, its file names or who it’s from, and neither can anyone who gets a copy of our database.</p>
        <h2 class="h3">What we store, and for how long</h2>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Data</th><th>Why</th><th>Kept</th></tr></thead>
          <tbody>
            <tr><td>Encrypted secret and its size</td><td>To deliver it</td><td>Until it’s opened the allowed number of times, destroyed, or expires</td></tr>
            <tr><td>When it was created, opened or destroyed</td><td>So the sender can see what happened</td><td>7 days after the secret is gone</td></tr>
            <tr><td>An allowed recipient’s email address, encrypted</td><td>To send them a code</td><td>Deleted with the secret</td></tr>
            <tr><td>Your name and email, if you sign in</td><td>To let you send and to show your name to recipients</td><td>While your account exists</td></tr>
            <tr><td>An audit log of events (never contents)</td><td>Security and accountability</td><td>Set by the operator, 365 days by default</td></tr>
            <tr><td>A session cookie, if you sign in</td><td>To keep you signed in</td><td>14 days</td></tr>
          </tbody>
        </table></div>
        <p>There are no analytics, advertising or third-party scripts, and no cookies for people who only open links. Your IP address is used briefly to limit abuse and isn’t stored with secrets or in the audit log.</p>
        <h2 class="h3">A limit you should know about</h2>
        <p>Like every web-based encryption tool, this one relies on the code this server sends to your browser. If you need protection even from the people running this server, use the Cryptex command-line tool, which encrypts on your own computer.</p>
        {c.demo && <><h2 class="h3">Public demo</h2><p>Don’t send real secrets. Everything is deleted within an hour and the whole service is wiped every night.</p></>}
      </main>
    </Page>
  );
}
