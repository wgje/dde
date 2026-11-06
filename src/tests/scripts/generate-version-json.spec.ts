import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const runnerSource = path.join(repoRoot, 'scripts', 'generate-version-json.cjs');
const tempRoots: string[] = [];
const sha40 = 'A'.repeat(40);
const sha64 = 'B'.repeat(64);
const previousVersion = Buffer.from('{"preserve":"exactly"}\n');

type Fixture = {
  root: string;
  runner: string;
  output: string;
  fakeBin: string;
  gitScript: string;
  marker: string;
};

function writeFile(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-version-evidence-'));
  const runner = path.join(root, 'scripts', 'generate-version-json.cjs');
  const output = path.join(root, 'dist', 'browser', 'version.json');
  const fakeBin = path.join(root, 'fake-bin');
  const gitScript = path.join(root, 'fake-git.cjs');
  const marker = path.join(root, 'git-launched');
  tempRoots.push(root);

  writeFile(runner, fs.readFileSync(runnerSource));
  writeFile(path.join(root, 'scripts', 'lib', 'artifact-stats-evidence.cjs'), fs.readFileSync(path.join(repoRoot, 'scripts', 'lib', 'artifact-stats-evidence.cjs')));
  writeFile(path.join(root, 'scripts', 'lib', 'artifact-output-publication.cjs'), fs.readFileSync(path.join(repoRoot, 'scripts', 'lib', 'artifact-output-publication.cjs')));
  writeFile(path.join(root, 'package.json'), '{"version":"1.2.3"}\n');
  const mainBytes = 'main artifact\n';
  writeFile(path.join(root, 'dist', 'browser', 'main.js'), mainBytes);
  writeFile(path.join(root, 'dist', 'browser', 'ngsw.json'), JSON.stringify({
    timestamp: 123,
    assetGroups: [{ name: 'app', urls: ['/main.js'] }],
    hashTable: { '/main.js': crypto.createHash('sha1').update(mainBytes).digest('hex') },
  }));
  writeFile(output, previousVersion);
  writeFile(gitScript, `
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_GIT_MARKER, 'launched');
if (process.env.FAKE_GIT_MODE === 'overflow') process.stdout.write('x'.repeat(2 * 1024 * 1024));
else {
  if (process.env.FAKE_GIT_STDOUT) process.stdout.write(process.env.FAKE_GIT_STDOUT);
  if (process.env.FAKE_GIT_STDERR) process.stderr.write(process.env.FAKE_GIT_STDERR);
}
if (process.env.FAKE_GIT_MODE === 'signal') process.kill(process.pid, 'SIGTERM');
else process.exit(Number(process.env.FAKE_GIT_STATUS || 0));
`);
  writeFile(path.join(fakeBin, 'git.cmd'), '@echo off\r\n"%FAKE_NODE%" "%FAKE_GIT_SCRIPT%" %*\r\n');
  const git = path.join(fakeBin, 'git');
  writeFile(git, '#!/bin/sh\nexec "$FAKE_NODE" "$FAKE_GIT_SCRIPT" "$@"\n');
  fs.chmodSync(git, 0o755);
  return { root, runner, output, fakeBin, gitScript, marker };
}

function childEnv(
  fixture: Fixture,
  explicit: Record<string, string> = {},
  contaminated: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const blocked = new Set([
    'github_sha', 'vercel_git_commit_sha', 'path', 'node_options',
    'fake_git_mode', 'fake_git_stdout', 'fake_git_stderr', 'fake_git_status',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(contaminated)) {
    if (!blocked.has(key.toLowerCase()) && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    PATH: fixture.fakeBin,
    FAKE_NODE: process.execPath,
    FAKE_GIT_SCRIPT: fixture.gitScript,
    FAKE_GIT_MARKER: fixture.marker,
    ...explicit,
  };
}

function runFixture(
  fixture: Fixture,
  explicit: Record<string, string> = {},
  contaminated: NodeJS.ProcessEnv = process.env,
  preload?: string,
) {
  const args = preload ? ['--require', preload, fixture.runner] : [fixture.runner];
  return spawnSync(process.execPath, args, {
    cwd: path.dirname(fixture.root),
    env: childEnv(fixture, explicit, contaminated),
    encoding: 'utf8',
    timeout: 5_000,
  });
}

function importFixture(fixture: Fixture) {
  const source = [
    `const loaded = require(${JSON.stringify(fixture.runner)});`,
    'process.stdout.write(JSON.stringify(Object.keys(loaded).sort()));',
  ].join('');
  return spawnSync(process.execPath, ['-e', source], {
    cwd: path.dirname(fixture.root),
    env: childEnv(fixture, { GITHUB_SHA: sha40 }),
    encoding: 'utf8',
    timeout: 5_000,
  });
}

function writePackage(fixture: Fixture, value: unknown): void {
  writeFile(path.join(fixture.root, 'package.json'), `${JSON.stringify(value)}\n`);
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableJson(child)]),
    );
  }
  return value;
}

function canonicalNgswHash(value: Record<string, unknown>): string {
  const normalized = { ...value };
  delete normalized['timestamp'];
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableJson(normalized)))
    .digest('hex');
}

function expectFailure(fixture: Fixture, result: ReturnType<typeof runFixture>, reason: string): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe(`[generate-version-json] ${reason}`);
  expect(result.stderr).not.toContain(fixture.root);
  expect(result.stderr).not.toContain('secret-value');
  expect(fs.readFileSync(fixture.output)).toEqual(previousVersion);
}

describe('generate-version-json git provenance', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['', 'github'],
    ['unknown', 'github'],
    ['a'.repeat(39), 'github'],
    ['a'.repeat(41), 'github'],
    ['g'.repeat(40), 'github'],
    ['secret-value-at-C:\\private\\token', 'github'],
  ])('rejects selected GitHub SHA %j without fallback', (value, source) => {
    const fixture = makeFixture();
    const result = runFixture(fixture, {
      GITHUB_SHA: value,
      VERCEL_GIT_COMMIT_SHA: sha40,
      FAKE_GIT_STDOUT: sha40,
    });
    expectFailure(fixture, result, `version-evidence-git-sha-invalid:${source}`);
    expect(fs.existsSync(fixture.marker)).toBe(false);
  });

  it('rejects selected empty Vercel SHA without Git fallback', () => {
    const fixture = makeFixture();
    const result = runFixture(fixture, { VERCEL_GIT_COMMIT_SHA: '', FAKE_GIT_STDOUT: sha40 });
    expectFailure(fixture, result, 'version-evidence-git-sha-invalid:vercel');
    expect(fs.existsSync(fixture.marker)).toBe(false);
  });

  it.each([
    [{ FAKE_GIT_STATUS: '2', FAKE_GIT_STDERR: 'secret-value C:\\private\\repo' }, 'version-evidence-git-sha-unavailable'],
    [{ FAKE_GIT_STDOUT: '' }, 'version-evidence-git-sha-invalid:git'],
    [{ FAKE_GIT_STDOUT: 'z'.repeat(40) }, 'version-evidence-git-sha-invalid:git'],
    [{ FAKE_GIT_MODE: 'overflow' }, 'version-evidence-git-sha-unavailable'],
    [{ FAKE_GIT_MODE: 'signal' }, 'version-evidence-git-sha-unavailable'],
  ] as const)('fails closed for Git execution/output %#', (gitEnv, reason) => {
    const fixture = makeFixture();
    expectFailure(fixture, runFixture(fixture, { ...gitEnv }), reason);
  });

  it.each([
    ['GITHUB_SHA', sha40, sha40.toLowerCase(), false],
    ['VERCEL_GIT_COMMIT_SHA', sha64, sha64.toLowerCase(), false],
    ['FAKE_GIT_STDOUT', `${sha40}\n`, sha40.toLowerCase(), true],
  ])('accepts valid %s evidence', (source, value, expected, launchesGit) => {
    const fixture = makeFixture();
    const result = runFixture(fixture, { [source]: value });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`✓ Wrote ${path.join('dist', 'browser', 'version.json')}`);
    const version = JSON.parse(fs.readFileSync(fixture.output, 'utf8'));
    expect(version).toMatchObject({ gitSha: expected, appVersion: '1.2.3', ngswHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(fs.existsSync(fixture.marker)).toBe(launchesGit);
  });

  it('removes contaminated case-insensitive SHA aliases before Git fallback', () => {
    const fixture = makeFixture();
    const contaminated = { ...process.env, github_sha: 'secret-value', Vercel_Git_Commit_Sha: 'unknown' };
    const result = runFixture(fixture, { FAKE_GIT_STDOUT: sha40 }, contaminated);
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(fixture.output, 'utf8')).gitSha).toBe(sha40.toLowerCase());
    expect(fs.existsSync(fixture.marker)).toBe(true);
  });

  it('keeps imports side-effect free and exposes only the supported API', () => {
    const fixture = makeFixture();
    const result = importFixture(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(JSON.stringify([
      'generateVersionJson',
      'main',
      'readPackageVersion',
    ]));
    expect(fs.readFileSync(fixture.output)).toEqual(previousVersion);
    expect(fs.existsSync(fixture.marker)).toBe(false);
  });

  it.each([
    ['missing package.json', (fixture: Fixture) => fs.rmSync(path.join(fixture.root, 'package.json')), 'version-evidence-package-json-unavailable'],
    ['unreadable package.json', (fixture: Fixture) => {
      fs.rmSync(path.join(fixture.root, 'package.json'));
      fs.mkdirSync(path.join(fixture.root, 'package.json'));
    }, 'version-evidence-package-json-unavailable'],
    ['malformed package.json', (fixture: Fixture) => writeFile(path.join(fixture.root, 'package.json'), '{'), 'version-evidence-package-json-invalid'],
    ['missing version', (fixture: Fixture) => writePackage(fixture, {}), 'version-evidence-package-version-missing'],
    ['non-string version', (fixture: Fixture) => writePackage(fixture, { version: 123 }), 'version-evidence-package-version-not-string'],
    ['empty version', (fixture: Fixture) => writePackage(fixture, { version: '' }), 'version-evidence-package-version-empty'],
    ['whitespace-only version', (fixture: Fixture) => writePackage(fixture, { version: ' \t ' }), 'version-evidence-package-version-empty'],
  ] as const)('rejects %s before mutating output', (_label, arrange, reason) => {
    const fixture = makeFixture();
    arrange(fixture);

    expectFailure(fixture, runFixture(fixture, { GITHUB_SHA: sha40 }), reason);
    expect(fs.existsSync(fixture.marker)).toBe(false);
  });

  it.each(['0.0.0', '1.2.3', '  release-candidate  '])(
    'preserves accepted package version %j exactly',
    (packageVersion) => {
      const fixture = makeFixture();
      writePackage(fixture, { version: packageVersion });

      const result = runFixture(fixture, { GITHUB_SHA: sha40 });

      expect(result.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(fixture.output, 'utf8')).appVersion).toBe(packageVersion);
    },
  );

  it('preserves GitHub, Vercel, and local Git precedence', () => {
    const github = makeFixture();
    const githubResult = runFixture(github, {
      GITHUB_SHA: sha40,
      VERCEL_GIT_COMMIT_SHA: sha64,
      FAKE_GIT_STDOUT: sha64,
    });
    expect(githubResult.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(github.output, 'utf8')).gitSha).toBe(sha40.toLowerCase());
    expect(fs.existsSync(github.marker)).toBe(false);

    const vercel = makeFixture();
    const vercelResult = runFixture(vercel, {
      VERCEL_GIT_COMMIT_SHA: sha64,
      FAKE_GIT_STDOUT: sha40,
    });
    expect(vercelResult.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(vercel.output, 'utf8')).gitSha).toBe(sha64.toLowerCase());
    expect(fs.existsSync(vercel.marker)).toBe(false);
  });

  it('preserves canonical, malformed, and missing NGSW evidence semantics', () => {
    const canonical = makeFixture();
    const canonicalNgsw = {
      timestamp: 123,
      zeta: { b: 2, a: 1 },
      assetGroups: [{ urls: ['/main.js'], name: 'app' }],
      hashTable: { '/main.js': crypto.createHash('sha1').update('main artifact\n').digest('hex') },
    };
    writeFile(path.join(canonical.root, 'dist', 'browser', 'ngsw.json'), JSON.stringify(canonicalNgsw));
    expect(runFixture(canonical, { GITHUB_SHA: sha40 }).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(canonical.output, 'utf8')).ngswHash)
      .toBe(canonicalNgswHash(canonicalNgsw));

    const drift = makeFixture();
    const driftPath = path.join(drift.root, 'dist', 'browser', 'ngsw.json');
    const driftNgsw = JSON.parse(fs.readFileSync(driftPath, 'utf8')) as { hashTable: Record<string, string> };
    driftNgsw.hashTable['/main.js'] = '0'.repeat(40);
    writeFile(driftPath, JSON.stringify(driftNgsw));
    expectFailure(drift, runFixture(drift, { GITHUB_SHA: sha40 }), 'version-evidence-unavailable');

    const malformed = makeFixture();
    const malformedBytes = Buffer.from('{not-json}\r\n');
    writeFile(path.join(malformed.root, 'dist', 'browser', 'ngsw.json'), malformedBytes);
    expectFailure(
      malformed,
      runFixture(malformed, { GITHUB_SHA: sha40 }),
      'version-evidence-unavailable',
    );

    const missing = makeFixture();
    fs.rmSync(path.join(missing.root, 'dist', 'browser', 'ngsw.json'));
    expect(runFixture(missing, { GITHUB_SHA: sha40 }).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(missing.output, 'utf8')).ngswHash).toBeNull();
  });

  it('rejects unreadable NGSW evidence before mutating output', () => {
    const fixture = makeFixture();
    const ngswPath = path.join(fixture.root, 'dist', 'browser', 'ngsw.json');
    fs.rmSync(ngswPath);
    fs.mkdirSync(ngswPath);

    expectFailure(
      fixture,
      runFixture(fixture, { GITHUB_SHA: sha40 }),
      'version-evidence-ngsw-unavailable',
    );
  });

  it('rejects serialization failure before mutating output', () => {
    const fixture = makeFixture();
    const preload = path.join(fixture.root, 'throwing-date.cjs');
    writeFile(preload, "Date.prototype.toISOString = () => { throw new Error('secret-value'); };\n");

    expectFailure(
      fixture,
      runFixture(fixture, { GITHUB_SHA: sha40 }, process.env, preload),
      'version-evidence-serialization-failed',
    );
  });

  it('preserves environment precedence, field order, and final LF', () => {
    const fixture = makeFixture();
    const result = runFixture(fixture, {
      GITHUB_SHA: sha40,
      NODE_ENV: 'production',
      NG_APP_SENTRY_ENVIRONMENT: 'preview',
      DEPLOYMENT_TARGET: 'fallback-deploy',
      NG_APP_DEPLOYMENT_TARGET: 'primary-deploy',
      SUPABASE_PROJECT_ALIAS: 'fallback-project',
      NG_APP_SUPABASE_PROJECT_ALIAS: 'primary-project',
      SENTRY_RELEASE: 'fallback-release',
      NG_APP_SENTRY_RELEASE: 'primary-release',
    });

    expect(result.status).toBe(0);
    const bytes = fs.readFileSync(fixture.output, 'utf8');
    const version = JSON.parse(bytes);
    expect(Object.keys(version)).toEqual([
      'gitSha',
      'buildTime',
      'environment',
      'appVersion',
      'deploymentTarget',
      'supabaseProjectAlias',
      'sentryRelease',
      'ngswHash',
    ]);
    expect(version).toMatchObject({
      environment: 'preview',
      deploymentTarget: 'primary-deploy',
      supabaseProjectAlias: 'primary-project',
      sentryRelease: 'primary-release',
    });
    expect(bytes.endsWith('\n')).toBe(true);
    expect(bytes.endsWith('\n\n')).toBe(false);
  });
});
