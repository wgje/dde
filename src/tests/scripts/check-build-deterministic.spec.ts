import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const repoRoot = path.resolve(__dirname, '../../..');
const runnerSource = path.join(repoRoot, 'scripts', 'ci', 'check-build-deterministic.cjs');
const statsEvidenceSource = path.join(repoRoot, 'scripts', 'lib', 'artifact-stats-evidence.cjs');
const requiredArtifacts = [
  'ngsw.json',
  'index.html',
  'launch.html',
  'version.json',
  'artifact-manifest.json',
] as const;
const tempRoots: string[] = [];
type RunResult = {
  output: string;
  status: number | null;
  ciValues: string[];
  projectRoot: string;
  nestedCopied: boolean;
  sourceCloseAttempted: boolean;
};
function writeFakeNpm(projectRoot: string): string {
  const binDir = path.join(projectRoot, 'fake-bin');
  const cliPath = path.join(binDir, 'fake-npm.cjs');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(cliPath, String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.join(' ') !== 'run build:stats') process.exit(91);
const statePath = process.env.FAKE_BUILD_STATE;
const count = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0;
const side = count === 0 ? 'A' : 'B';
fs.writeFileSync(statePath, String(count + 1));
fs.appendFileSync(process.env.FAKE_CI_LOG, side + ':' + process.env.CI + '\n');

const scenario = process.env.FAKE_BUILD_SCENARIO;
const dist = path.join(process.cwd(), 'dist', 'browser');
if (scenario === 'child-failure' && side === 'A') process.exit(73);
fs.mkdirSync(dist, { recursive: true });
const omitted = (name) => scenario === 'omit-both:' + name
  || scenario === 'omit-' + side.toLowerCase() + ':' + name;
const write = (name, value) => {
  if (!omitted(name)) {
    fs.mkdirSync(path.dirname(path.join(dist, name)), { recursive: true });
    fs.writeFileSync(path.join(dist, name), value);
  }
};
write('main-ABC.js', 'stable bundle\n');
write('assets/nested.txt', 'nested evidence\n');
const mainHash = scenario === 'bad-ngsw-hash'
  ? '0'.repeat(40)
  : crypto.createHash('sha1').update('stable bundle\n').digest('hex');
write('ngsw.json', JSON.stringify({ timestamp: side === 'A' ? 1 : 2, assetGroups: [{ name: 'app', urls: ['/main-ABC.js'] }], hashTable: { '/main-ABC.js': mainHash } }) + '\n');
write('index.html', '<link rel="modulepreload" href="main-ABC.js">\n');
write('launch.html', '<link rel="modulepreload" href="main-ABC.js">\n');
write('version.json', JSON.stringify({ gitSha: 'stable', buildTime: side }) + '\n');
if (scenario === 'mismatch' && side === 'B') write('main-ABC.js', 'different bundle\n');
if (scenario === 'mismatch' && side === 'B') {
  const ngswPath = path.join(dist, 'ngsw.json');
  const ngsw = JSON.parse(fs.readFileSync(ngswPath, 'utf8'));
  ngsw.hashTable['/main-ABC.js'] = crypto.createHash('sha1').update('different bundle\n').digest('hex');
  write('ngsw.json', JSON.stringify(ngsw) + '\n');
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = Object.fromEntries(
  fs.readdirSync(dist, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ['/' + entry.name, { sha256: sha256(path.join(dist, entry.name)) }]),
);
write('artifact-manifest.json', JSON.stringify({ schemaVersion: 1, files }) + '\n');
if (scenario === 'file-link-a') {
  const target = path.join(process.cwd(), 'external-link.js');
  fs.writeFileSync(target, 'linked bundle\n');
  if (side === 'A') fs.symlinkSync(target, path.join(dist, 'chunk-LINK.js'), 'file');
  else write('chunk-LINK.js', 'linked bundle\n');
}
if (scenario === 'dangling-link') fs.symlinkSync(path.join(process.cwd(), 'missing-secret.js'), path.join(dist, 'chunk-LINK.js'), 'file');
if (scenario === 'root-junction-a' && side === 'A') {
  const target = path.join(process.cwd(), 'external-browser');
  fs.renameSync(dist, target);
  fs.symlinkSync(target, dist, 'junction');
}
if (scenario === 'stale-a:index.html' && side === 'A') {
  fs.rmSync(path.join(dist, 'index.html'));
}
`);

  writeFileSync(
    path.join(binDir, 'npm.cmd'),
    `@echo off\r\n"${process.execPath}" "${cliPath}" %*\r\n`,
  );
  const posixNpm = path.join(binDir, 'npm');
  writeFileSync(posixNpm, `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`);
  chmodSync(posixNpm, 0o755);
  return binDir;
}
function writeCopyPreload(projectRoot: string): string {
  const preloadPath = path.join(projectRoot, 'copy-preload.cjs');
  writeFileSync(preloadPath, String.raw`
const fs = require('node:fs'), path = require('node:path');
const scenario = process.env.FAKE_BUILD_SCENARIO;
const source = path.join(__dirname, 'dist', 'browser', 'main-ABC.js');
const originalOpen = fs.openSync, originalRead = fs.readSync, originalWrite = fs.writeSync;
const originalFstat = fs.fstatSync, originalLstat = fs.lstatSync, originalClose = fs.closeSync;
let sourceFd, destinationFd, sourceRead = false, destinationWritten = false, truncated = false;
fs.openSync = function(file, flags, ...rest) {
  const resolved = path.resolve(String(file));
  if (scenario === 'identity-drift' && resolved === source && flags === 'r') {
    fs.writeFileSync(source + '.replacement', 'stable bundle\n');
    fs.renameSync(source + '.replacement', source);
  }
  const fd = originalOpen.call(this, file, flags, ...rest);
  if (resolved === source && flags === 'r') sourceFd = fd;
  if (resolved.includes(path.join('.tmp', 'build-a')) && resolved.endsWith('main-ABC.js')) destinationFd = fd;
  return fd;
};
fs.readSync = function(fd, ...args) {
  if ((scenario === 'short-read' || scenario === 'close-failure-primary') && fd === sourceFd && !sourceRead) { sourceRead = true; return 0; }
  const count = originalRead.call(this, fd, ...args);
  if (scenario === 'size-drift' && fd === sourceFd && count > 0 && !sourceRead) { fs.appendFileSync(source, 'x'); sourceRead = true; }
  return count;
};
fs.writeSync = function(fd, ...args) {
  if (scenario === 'short-write' && fd === destinationFd && !destinationWritten) { destinationWritten = true; return 0; }
  const count = originalWrite.call(this, fd, ...args); if (fd === destinationFd && count > 0) destinationWritten = true; return count;
};
fs.fstatSync = function(fd, ...args) {
  if (scenario === 'destination-truncation' && fd === destinationFd && destinationWritten && !truncated) { fs.ftruncateSync(fd, 0); truncated = true; }
  return originalFstat.call(this, fd, ...args);
};
fs.lstatSync = function(file, ...args) {
  if (scenario === 'secret-error' && path.resolve(String(file)) === source) throw new Error('secret-token ' + source);
  return originalLstat.call(this, file, ...args);
};
fs.closeSync = function(fd) {
  if (scenario?.startsWith('close-failure') && fd === destinationFd) throw new Error('secret-close ' + source);
  if (scenario?.startsWith('close-failure') && fd === sourceFd) fs.writeFileSync(process.env.FAKE_CLOSE_MARKER, 'attempted');
  return originalClose.call(this, fd);
};
`);
  return preloadPath;
}
function runScenario(scenario: string): RunResult {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'nanoflow-build-deterministic-'));
  tempRoots.push(projectRoot);
  const runnerPath = path.join(projectRoot, 'scripts', 'ci', 'check-build-deterministic.cjs');
  const outsideCwd = path.join(projectRoot, 'outside-cwd');
  mkdirSync(path.dirname(runnerPath), { recursive: true });
  mkdirSync(outsideCwd);
  copyFileSync(runnerSource, runnerPath);
  mkdirSync(path.join(projectRoot, 'scripts', 'lib'), { recursive: true });
  copyFileSync(statsEvidenceSource, path.join(projectRoot, 'scripts', 'lib', 'artifact-stats-evidence.cjs'));
  const ciLog = path.join(projectRoot, 'ci.log');
  const result = spawnSync(process.execPath, ['--require', writeCopyPreload(projectRoot), runnerPath], {
    cwd: outsideCwd,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: `${writeFakeNpm(projectRoot)}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_BUILD_SCENARIO: scenario,
      FAKE_BUILD_STATE: path.join(projectRoot, 'build-state'),
      FAKE_CI_LOG: ciLog,
      FAKE_CLOSE_MARKER: path.join(projectRoot, 'source-close-attempted'),
    },
  });

  return {
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    status: result.status,
    projectRoot,
    nestedCopied: existsSync(path.join(projectRoot, '.tmp', 'build-a', 'assets', 'nested.txt')),
    sourceCloseAttempted: existsSync(path.join(projectRoot, 'source-close-attempted')),
    ciValues: existsSync(ciLog)
      ? readFileSync(ciLog, 'utf8').trim().split(/\r?\n/)
      : [],
  };
}
function expectMissing(result: RunResult, side: 'A' | 'B', artifact: string): void {
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain(
    `Deterministic build evidence missing: side=${side} artifact=${artifact}`,
  );
  expect(result.output).not.toContain('check-build-deterministic PASSED');
}

function expectSnapshotFailure(result: RunResult, reason: string): void {
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain(`Deterministic build evidence unavailable: side=A scope=snapshot-copy reason=${reason}`);
  expect(result.output).not.toContain(result.projectRoot);
  expect(result.output).not.toMatch(/secret-(?:token|close)|main-ABC\.js|Error:|at Object\./);
  expect(result.output).not.toContain('check-build-deterministic PASSED');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-build-deterministic guard', () => {
  it.each(requiredArtifacts)('rejects equal A/B omission of %s', (artifact) => {
    const result = runScenario(`omit-both:${artifact}`);
    expectMissing(result, 'A', artifact);
    expectMissing(result, 'B', artifact);
  });
  it('rejects equal empty hashed-asset evidence', () => {
    const result = runScenario('omit-both:main-ABC.js');
    expectMissing(result, 'A', 'hashed-assets');
    expectMissing(result, 'B', 'hashed-assets');
  });
  it('rejects post NGSW hash-table and disk-byte drift', () => {
    const result = runScenario('bad-ngsw-hash');
    expect(result.status).toBe(1);
    expect(result.output).toContain('scope=ngsw-post-validation');
    expect(result.output).not.toContain('check-build-deterministic PASSED');
  });
  it.each(['A', 'B'] as const)('preflights required evidence independently for side %s', (side) => {
    const result = runScenario(`omit-${side.toLowerCase()}:index.html`);
    expectMissing(result, side, 'index.html');
  });
  it('rejects explicitly stale post-manifest deletion evidence', () => {
    const result = runScenario('stale-a:index.html');
    expectMissing(result, 'A', 'index.html');
  });
  it('accepts complete stable evidence and forces CI cache semantics', () => {
    const result = runScenario('valid');
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('ngsw.json stable content identical (timestamp ignored)');
    expect(result.output).toContain('version.json stable fields identical (buildTime ignored)');
    expect(result.output).toContain('artifact-manifest.json stable content identical');
    expect(result.output).toContain('check-build-deterministic PASSED');
    expect(result.ciValues).toEqual(['A:true', 'B:true']);
    expect(result.nestedCopied).toBe(true);
  });
  it.each([
    ['file-link-a', 'source-entry-invalid'], ['root-junction-a', 'source-root-invalid'],
    ['dangling-link', 'source-entry-invalid'], ['identity-drift', 'source-drift'],
    ['size-drift', 'source-drift'], ['short-read', 'source-read-short'],
    ['short-write', 'destination-write-short'], ['destination-truncation', 'destination-size-invalid'],
    ['secret-error', 'snapshot-io-failed'], ['close-failure-primary', 'source-read-short'],
    ['close-failure-only', 'descriptor-close-failed'],
  ])('fails closed for snapshot copy evidence: %s', (scenario, reason) => {
    const result = runScenario(scenario);
    if (scenario.startsWith('close-failure')) expect.soft(result.sourceCloseAttempted).toBe(true);
    expectSnapshotFailure(result, reason);
  });
  it.each([['mismatch', 'Hashed asset manifest differs'], ['child-failure', '']])('preserves existing failure: %s', (scenario, message) => {
    const result = runScenario(scenario);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(message);
    expect(result.output).not.toContain('Deterministic build evidence unavailable');
  });
});
