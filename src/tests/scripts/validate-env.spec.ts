import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');
const validateEnvScript = path.join(repoRoot, 'scripts', 'validate-env.cjs');

function runValidateEnv(overrides: Record<string, string>) {
  return spawnSync(process.execPath, [validateEnvScript, '--production'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NG_APP_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      NG_APP_SUPABASE_ANON_KEY: '',
      NG_APP_DEV_AUTO_LOGIN_EMAIL: '',
      NG_APP_DEV_AUTO_LOGIN_PASSWORD: '',
      ...overrides,
    },
    encoding: 'utf-8',
  });
}

describe('validate-env Supabase API key validation', () => {
  it('accepts Supabase publishable keys for production browser builds', () => {
    const result = runValidateEnv({
      NG_APP_SUPABASE_ANON_KEY: 'sb_publishable_test_key_for_browser_builds_1234567890',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('环境变量验证通过');
  });

  it('rejects Supabase secret keys for production browser builds', () => {
    const result = runValidateEnv({
      NG_APP_SUPABASE_ANON_KEY: 'sb_secret_do_not_ship_this_key_in_a_browser_bundle_1234567890',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('不能使用 Supabase secret key');
  });
});
