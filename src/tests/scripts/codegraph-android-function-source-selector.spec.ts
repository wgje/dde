import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const generatorPath = path.join(repoRoot, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs');
const functionSourceEnv = 'NANOFLOW_CODEGRAPH_ANDROID_FUNCTION_SOURCE_DEFAULT';
const importSourceEnv = 'NANOFLOW_CODEGRAPH_ANDROID_IMPORT_SOURCE_DEFAULT';
const tempRoots: string[] = [];

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-function-selector-'));
  tempRoots.push(root);
  const kotlinPath = path.join(
    root,
    'android',
    'app',
    'src',
    'main',
    'java',
    'app',
    'example',
    'SelectorFixture.kt',
  );
  fs.mkdirSync(path.dirname(kotlinPath), { recursive: true });
  fs.writeFileSync(kotlinPath, 'package app.example\n\nfun selectorFixture(): String = "ok"\n');
  return root;
}

function runGenerator(
  root: string,
  args: string[] = [],
  envOverrides: NodeJS.ProcessEnv = {},
) {
  const env = { ...process.env };
  const selectorEnvKeys = new Set([functionSourceEnv, importSourceEnv].map(key => key.toLowerCase()));
  for (const key of Object.keys(env)) {
    if (selectorEnvKeys.has(key.toLowerCase())) delete env[key];
  }
  Object.assign(env, envOverrides);
  return spawnSync(process.execPath, [generatorPath, '--root', root, '--stdout', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function expectSuccess(result: ReturnType<typeof spawnSync>): void {
  expect(result.status, `stderr: ${result.stderr}\nerror: ${result.error?.message ?? ''}`).toBe(0);
}

function normalizeGeneratedTimes(stdout: string): string {
  return JSON.stringify(JSON.parse(stdout), (key, value) => (
    key === 'generatedAt' || key === 'updatedAt' ? '<generated-time>' : value
  ));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Android Kotlin function source selector', { timeout: 30_000 }, () => {
  it('uses native by default while explicit and environment local remain byte-equivalent', () => {
    const root = makeFixture();
    const builtIn = runGenerator(root);
    const explicitLocal = runGenerator(root, ['--android-function-source', 'local']);
    const environmentLocal = runGenerator(root, [], { [functionSourceEnv]: 'local' });

    expect(builtIn.status).toBe(1);
    expect(builtIn.stderr).toContain('native-db-missing');
    expectSuccess(explicitLocal);
    expectSuccess(environmentLocal);
    expect(normalizeGeneratedTimes(environmentLocal.stdout)).toBe(normalizeGeneratedTimes(explicitLocal.stdout));
  });

  it('fails closed without local fallback when the environment selects native', () => {
    const result = runGenerator(makeFixture(), [], { [functionSourceEnv]: 'native' });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('native-db-missing');
  });

  it('gives the explicit CLI selector precedence in both directions', () => {
    const root = makeFixture();
    const explicitLocal = runGenerator(root, ['--android-function-source', 'local']);
    const localOverride = runGenerator(root, ['--android-function-source', 'local'], {
      [functionSourceEnv]: 'native',
    });
    const nativeOverride = runGenerator(root, ['--android-function-source', 'native'], {
      [functionSourceEnv]: 'local',
    });

    expectSuccess(explicitLocal);
    expectSuccess(localOverride);
    expect(normalizeGeneratedTimes(localOverride.stdout)).toBe(normalizeGeneratedTimes(explicitLocal.stdout));
    expect(nativeOverride.status).toBe(1);
    expect(nativeOverride.stdout).toBe('');
    expect(nativeOverride.stderr).toContain('native-db-missing');
  });

  it('attributes invalid environment and CLI values to their sources', () => {
    const root = makeFixture();
    const invalidEnvironment = runGenerator(root, [], { [functionSourceEnv]: 'invalid' });
    const invalidCli = runGenerator(root, ['--android-function-source', 'invalid']);

    expect(invalidEnvironment.status).toBe(1);
    expect(invalidEnvironment.stderr).toContain(`Invalid value for ${functionSourceEnv}: invalid`);
    expect(invalidCli.status).toBe(1);
    expect(invalidCli.stderr).toContain('Invalid value for --android-function-source: invalid');
  });

  it('gives help precedence and documents selector precedence and the built-in native default', () => {
    const result = runGenerator(makeFixture(), ['--help'], { [functionSourceEnv]: 'invalid' });

    expectSuccess(result);
    expect(result.stdout).toContain('--android-function-source <local|native>');
    expect(result.stdout).toContain(`Explicit CLI overrides ${functionSourceEnv}`);
    expect(result.stdout).toContain('built-in default is native');
  });
});
