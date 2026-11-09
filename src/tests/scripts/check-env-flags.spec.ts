import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const runnerPath = path.join(process.cwd(), 'scripts', 'ci', 'check-env-flags.cjs');
const fixtureRoots: string[] = [];
const migrationFlags = [
  'NG_APP_SENTRY_ENVIRONMENT',
  'NG_APP_CANONICAL_ORIGIN',
  'NG_APP_ORIGIN_GATE_MODE',
  'NG_APP_READ_ONLY_PREVIEW',
  'NG_APP_DEPLOYMENT_TARGET',
  'NG_APP_SUPABASE_PROJECT_ALIAS',
  'NG_APP_SENTRY_RELEASE',
  'NG_APP_SYNC_RPC_ENABLED',
  'NG_APP_SYNC_LEASE_ENABLED',
  'NG_APP_SYNC_PROTOCOL_VERSION',
  'NG_APP_DEPLOYMENT_EPOCH',
] as const;

interface FixtureOptions {
  includeDocs?: boolean;
  missingCodeFlag?: string;
  missingDocFlag?: string;
}

function createFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-env-flags-'));
  fixtureRoots.push(root);
  const scriptDir = path.join(root, 'scripts', 'ci');
  const executionCwd = path.join(root, 'execution-cwd');
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(executionCwd);
  const runner = path.join(scriptDir, 'check-env-flags.cjs');
  copyFileSync(runnerPath, runner);

  const codeFlags = migrationFlags.filter(flag => flag !== options.missingCodeFlag);
  writeFileSync(
    path.join(root, 'scripts', 'set-env.cjs'),
    codeFlags.map(flag => `void process.env.${flag};`).join('\n') + '\n',
  );

  if (options.includeDocs !== false) {
    const docFlags = migrationFlags.filter(flag => flag !== options.missingDocFlag);
    const docsDir = path.join(root, 'docs');
    mkdirSync(docsDir);
    writeFileSync(
      path.join(docsDir, 'cloudflare-migration-plan.md'),
      docFlags.map(flag => `- ${flag}`).join('\n') + '\n',
    );
  }

  return { executionCwd, runner };
}

function runFixture(options: FixtureOptions = {}) {
  const fixture = createFixture(options);
  return spawnSync(process.execPath, [fixture.runner], {
    cwd: fixture.executionCwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('check-env-flags documentation snapshot contract', () => {
  it('fails closed when the required documentation snapshot is absent', () => {
    const result = runFixture({ includeDocs: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'docs/cloudflare-migration-plan.md missing - env flag drift cannot be validated',
    );
    expect(result.stdout).not.toContain('check-env-flags PASSED');
  });

  it('passes when code and documentation contain every migration flag', () => {
    const result = runFixture();

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain(`All ${migrationFlags.length} migration flags consumed`);
    expect(result.stdout).toContain('check-env-flags PASSED');
  });

  it('preserves fail-closed behavior for flags missing from code or documentation', () => {
    const missingCode = runFixture({ missingCodeFlag: migrationFlags[0] });
    const missingDocs = runFixture({ missingDocFlag: migrationFlags[1] });

    expect(missingCode.status).toBe(1);
    expect(missingCode.stderr).toContain(migrationFlags[0]);
    expect(missingCode.stderr).toContain('not consumed by set-env.cjs');
    expect(missingDocs.status).toBe(1);
    expect(missingDocs.stderr).toContain(migrationFlags[1]);
    expect(missingDocs.stderr).toContain('missing from docs/cloudflare-migration-plan.md');
  });
});
