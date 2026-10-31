/** "Copy all as .env": sourcing the file must never run or expand anything inside a value (W7). */
import { describe, expect, it } from 'vitest';
import { envName, toEnv } from './Output';

const field = (k: string, v: string) => ({ t: 'field' as const, k, v, secret: true });

describe('toEnv', () => {
  it('leaves plain values bare and single-quotes the rest', () => {
    expect(toEnv([field('Host', 'db:5432/x'), field('pass word', 'a b'), field('1st', "it's")]))
      .toBe("HOST=db:5432/x\nPASS_WORD='a b'\n_1ST='it'\\''s'\n");
  });

  it('gives back every value exactly when a shell sources it', async () => {
    // Node's own module (the web build has no Node types).
    const { execFileSync } = (await import('node:child_process' as string)) as { execFileSync: (f: string, a: string[], o: object) => string };
    const values = ['pa$$w0rd', 'x`echo PWNED>&2`y', 'a$(id -un)b', "it's \"quoted\" \\ back", 'two\nlines', '${HOME}', '!event'];
    const env = toEnv(values.map((v, i) => field(`V${i}`, v)));
    const script = `${env}\nprintf '%s\\0' ${values.map((_, i) => `"$V${i}"`).join(' ')}`;
    const out = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
    expect(out.split('\0').slice(0, -1)).toEqual(values);
  });

  it('never lets a field name be one the shell acts on (C3)', () => {
    for (const k of ['PS1', 'ps4', 'Prompt command', 'PROMPT_COMMAND', 'BASH_ENV', 'ENV', 'PATH', 'IFS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
      'HISTFILE', 'SHELLOPTS', 'BASHOPTS', 'BASH_FUNC_ls%%', 'CDPATH', 'GLOBIGNORE', 'MAILPATH', 'TERM', 'HOME', 'PROMPT', 'RPROMPT', 'ZDOTDIR']) {
      expect(envName(k), k).toMatch(/^_/);
    }
    for (const k of ['DB_PASSWORD', 'Host', 'API key', 'MY_PATH', 'HOMEPAGE', 'ENVIRONMENT']) expect(envName(k), k).toMatch(/^[A-Z]/);
    for (const k of ['SPROMPT', 'NULLCMD', 'READNULLCMD', 'MANPAGER', 'BROWSER', 'SUDO_EDITOR', 'KUBE_EDITOR', 'SYSTEMD_EDITOR', 'GH_PAGER', 'GH_EDITOR',
      'npm_config_script_shell', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'https_proxy', 'HTTP_PROXY', 'ALL_PROXY',
      'EDITOR', 'VISUAL', 'PAGER', 'GIT_SSH_COMMAND', 'NODE_OPTIONS', 'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT']) {
      expect(envName(k), k).toMatch(/^_/); // F7
    }
    expect(envName('1st')).toBe('_1ST');
    expect(envName('db-host.name')).toBe('DB_HOST_NAME'); // only letters, digits and _
  });

  it('runs nothing when an interactive shell sources it and shows a prompt', async () => {
    const { execFileSync } = (await import('node:child_process' as string)) as { execFileSync: (f: string, a: string[], o: object) => string };
    const env = toEnv([field('prompt command', 'echo PWNED-1'), field('PS1', '$(echo PWNED-2) $ '), field('PS0', '$(echo PWNED-3)'), field('db password', 'x')]);
    const out = execFileSync('/bin/bash', ['--norc', '--noprofile', '-i'], { input: `${env}\necho done\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    expect(out).toContain('done');
    expect(out).not.toContain('PWNED');
  });

  it('never gives two fields the same name: the second would overwrite the first (Q6)', () => {
    expect(toEnv([field('', 'a'), field('Пароль', 'b'), field('密码', 'c'), field('KEY', 'd'), field('key', 'e'), field('VALUE_2', 'f')]))
      .toBe('VALUE=a\nVALUE_2=b\nVALUE_3=c\nKEY=d\nKEY_2=e\nVALUE_2_2=f\n');
  });
});
