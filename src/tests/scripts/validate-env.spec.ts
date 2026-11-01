import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');
const fixtureKey = 'sb_publishable_testkeyforbrowserbuild_12345678';
const tempRoots: string[] = [];

function makeValidateEnvFixture(): { root: string; script: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-env-credential-fence-'));
  tempRoots.push(root);
  const scripts = path.join(root, 'scripts');
  const lib = path.join(scripts, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'scripts/validate-env.cjs'), path.join(scripts, 'validate-env.cjs'));
  fs.copyFileSync(
    path.join(repoRoot, 'scripts/lib/supabase-browser-key-safety.cjs'),
    path.join(lib, 'supabase-browser-key-safety.cjs'),
  );
  return { root, script: path.join(scripts, 'validate-env.cjs') };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function legacyJwt(payload: object | string): string {
  const payloadSource = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return [
    base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64Url(payloadSource),
    base64Url('signature'),
  ].join('.');
}

function runValidateEnv(overrides: Record<string, string>) {
  const fixture = makeValidateEnvFixture();
  return spawnSync(process.execPath, [fixture.script, '--production'], {
    cwd: fixture.root,
    env: {
      ...process.env,
      NODE_PATH: path.join(repoRoot, 'node_modules'),
      NG_APP_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      NG_APP_SUPABASE_ANON_KEY: '',
      NG_APP_DEV_AUTO_LOGIN_EMAIL: '',
      NG_APP_DEV_AUTO_LOGIN_PASSWORD: '',
      ...overrides,
    },
    encoding: 'utf-8',
  });
}

function runValidateEnvWithLocal(
  overrides: Record<string, string>,
  localValues: Record<string, string> | string,
) {
  const fixture = makeValidateEnvFixture();
  const localSource = typeof localValues === 'string'
    ? localValues
    : `${Object.entries(localValues).map(([name, value]) => `${name}=${value}`).join('\n')}\n`;
  fs.writeFileSync(
    path.join(fixture.root, '.env.local'),
    localSource,
    'utf8',
  );
  return spawnSync(process.execPath, [fixture.script, '--production'], {
    cwd: fixture.root,
    env: {
      ...process.env,
      NODE_PATH: path.join(repoRoot, 'node_modules'),
      NG_APP_DEV_AUTO_LOGIN_EMAIL: '',
      NG_APP_DEV_AUTO_LOGIN_PASSWORD: '',
      ...overrides,
    },
    encoding: 'utf8',
  });
}

describe('validate-env Supabase API key validation', () => {
  it('accepts Supabase publishable keys for production browser builds', () => {
    const result = runValidateEnv({
      NG_APP_SUPABASE_ANON_KEY: fixtureKey,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('环境变量验证通过');
  }, 10_000);

  it.each([
    'http://localhost:54321',
    'HTTPS://CUSTOM.EXAMPLE',
  ])('accepts a shared-fence-valid self-host URL %s', url => {
    const result = runValidateEnv({
      NG_APP_SUPABASE_URL: url,
      NG_APP_SUPABASE_ANON_KEY: fixtureKey,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('环境变量验证通过');
  }, 10_000);

  it('rejects Supabase secret keys for production browser builds', () => {
    const result = runValidateEnv({
      NG_APP_SUPABASE_ANON_KEY: 'sb_' + 'secret_do_not_ship_this_key_in_a_browser_bundle_1234567890',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('不能使用 Supabase secret key');
  }, 10_000);

  it.each([
    'sb_publishable_testkeyforbrowserbuil_12345678',
    'sb_publishable_testkeyforbrowserbuild_1234567',
    'sb_publishable_testkeyforbrowserbuild_123456789',
  ])('rejects publishable-key shape near miss %s', invalidKey => {
    const result = runValidateEnv({ NG_APP_SUPABASE_ANON_KEY: invalidKey });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Supabase publishable key 格式异常');
  }, 10_000);

  it('rejects a canonical JWT with a non-anon role', () => {
    const result = runValidateEnv({
      NG_APP_SUPABASE_ANON_KEY: legacyJwt({
        iss: 'supabase',
        role: 'authenticated',
        ref: 'abcdefghijklmnopqrst',
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Supabase legacy anon JWT 格式异常');
  }, 10_000);

  it('rejects decoded duplicate JWT claim names', () => {
    const result = runValidateEnv({
      NG_APP_SUPABASE_ANON_KEY: legacyJwt(
        '{"iss":"supabase","role":"anon","\\u0072ole":"anon","ref":"abcdefghijklmnopqrst"}',
      ),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Supabase legacy anon JWT 格式异常');
  }, 10_000);

  it('rejects a multi-label Supabase hostname', () => {
    const result = runValidateEnv({
      NG_APP_SUPABASE_URL: 'https://nested.abcdefghijklmnopqrst.supabase.co',
      NG_APP_SUPABASE_ANON_KEY: fixtureKey,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Supabase URL 格式异常');
  }, 10_000);

  it('rejects an invalid local key even when a valid process key shadows it', () => {
    const unsafeSuffix = 'must_not_be_printed';
    const result = runValidateEnvWithLocal({
      NG_APP_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      NG_APP_SUPABASE_ANON_KEY: fixtureKey,
    }, {
      NG_APP_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      NG_APP_SUPABASE_ANON_KEY: `sb_secret_${unsafeSuffix}`,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('不能使用 Supabase secret key');
    expect(`${result.stdout}${result.stderr}`).not.toContain(unsafeSuffix);
  }, 10_000);

  it.each([
    ['dangerous then legal', `sb_secret_hidden_duplicate\nNG_APP_SUPABASE_ANON_KEY=${fixtureKey}`],
    [
      'legal then different legal',
      `${fixtureKey}\nNG_APP_SUPABASE_ANON_KEY=sb_publishable_anotherbrowserfixture1_87654321`,
    ],
  ])('rejects %s duplicate local key definitions before normalization', (_name, keyLines) => {
    const result = runValidateEnvWithLocal({}, [
      'NG_APP_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co',
      `NG_APP_SUPABASE_ANON_KEY=${keyLines}`,
      '',
    ].join('\n'));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Supabase browser key 定义重复');
    expect(`${result.stdout}${result.stderr}`).not.toContain('hidden_duplicate');
  }, 10_000);
});
