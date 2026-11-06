import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const runnerSource = path.join(repoRoot, 'scripts', 'run-ng.cjs');
const portHelperSource = path.join(repoRoot, 'scripts', 'dev-server-port.cjs');
const roots: string[] = [];

type Candidate = 'file' | 'missing' | 'directory' | 'symlink' | 'dangling' | 'junction';
type Fixture = ReturnType<typeof createFixture>;

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function markerScript(marker: string, status = 0): string {
  return `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));process.exit(${status});\n`;
}

function createFixture(candidate: Candidate = 'file', options: { trustedStatus?: number; setEnvStatus?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-ng-launcher-'));
  roots.push(root);
  const scripts = path.join(root, 'scripts');
  const runtime = path.join(root, 'runtime');
  const fakeNode = path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
  const runner = path.join(scripts, 'run-ng.cjs');
  const preload = path.join(root, 'preload.cjs');
  const poisonMarker = path.join(root, 'poison.json');
  const pathPoisonMarker = path.join(root, 'path-poison.json');
  const trustedMarker = path.join(root, 'trusted.json');
  const angularMarker = path.join(root, 'angular.json');
  const spawnMarker = path.join(root, 'spawn.json');
  const candidatePath = path.join(runtime, 'node_modules', 'npm', 'bin', 'npx-cli.js');
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(process.execPath, fakeNode);
  fs.copyFileSync(runnerSource, runner);
  fs.copyFileSync(portHelperSource, path.join(scripts, 'dev-server-port.cjs'));
  write(path.join(scripts, 'set-env.cjs'), `require('node:fs').mkdirSync(${JSON.stringify(path.join(root, '.tmp'))},{recursive:true});require('node:fs').writeFileSync(${JSON.stringify(path.join(root, '.tmp', 'index.generated.html'))},'ok');process.exit(${options.setEnvStatus ?? 0});\n`);
  write(path.join(root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'), markerScript(angularMarker));
  write(preload, `Object.defineProperty(process,'execPath',{value:${JSON.stringify(fakeNode)}});Object.defineProperty(process.versions,'node',{value:process.env.FAKE_NODE_VERSION||'24.0.0'});Object.defineProperty(process,'platform',{value:process.env.FAKE_PLATFORM||'win32'});const p=require('node:path'),originalResolve=p.resolve;p.resolve=function(first,...rest){if(process.env.ESCAPE_LAUNCHER&&rest.join('/')==='node_modules/npm/bin/npx-cli.js')return ${JSON.stringify(root)};return originalResolve(first,...rest)};if(process.env.DENY_LAUNCHER){const fs=require('node:fs');const target=${JSON.stringify(candidatePath)};for(const key of ['accessSync','openSync']){const original=fs[key];fs[key]=function(file,...args){if(p.resolve(file)===target)throw new Error('secret '+target);return original.call(this,file,...args)}}}if(process.env.MOCK_SPAWN){const fs=require('node:fs'),cp=require('node:child_process'),{EventEmitter}=require('node:events');cp.spawn=function(command,args){fs.writeFileSync(${JSON.stringify(spawnMarker)},JSON.stringify([command,args]));const child=new EventEmitter();child.killed=false;child.kill=()=>{};process.nextTick(()=>child.emit('exit',0,null));return child}}\n`);
  write(path.join(root, 'poison.cjs'), markerScript(poisonMarker));
  write(path.join(root, 'npx.cmd'), `@"${process.execPath}" "${path.join(root, 'poison.cjs')}" %*\r\n`);
  const poisonBin = path.join(root, 'poison-bin');
  write(path.join(poisonBin, 'path-poison.cjs'), markerScript(pathPoisonMarker));
  write(path.join(poisonBin, 'npx.cmd'), `@"${process.execPath}" "${path.join(poisonBin, 'path-poison.cjs')}" %*\r\n`);

  const trustedSource = `const{spawnSync}=require('node:child_process'),fs=require('node:fs');fs.writeFileSync(${JSON.stringify(trustedMarker)},JSON.stringify(process.argv.slice(2)));const i=process.argv.indexOf('--');const r=spawnSync(process.execPath,process.argv.slice(i+1),{stdio:'inherit',env:process.env});process.exit(${options.trustedStatus ?? 'r.status??1'});\n`;
  if (candidate === 'file') write(candidatePath, trustedSource);
  if (candidate === 'directory') fs.mkdirSync(candidatePath, { recursive: true });
  if (candidate === 'symlink' || candidate === 'dangling') {
    const target = path.join(root, candidate === 'symlink' ? 'trusted-target.cjs' : 'missing-target.cjs');
    if (candidate === 'symlink') write(target, trustedSource);
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.symlinkSync(target, candidatePath, 'file');
  }
  if (candidate === 'junction') {
    const external = path.join(root, 'external-node-modules');
    write(path.join(external, 'npm', 'bin', 'npx-cli.js'), trustedSource);
    fs.symlinkSync(external, path.join(runtime, 'node_modules'), 'junction');
  }
  return { root, runner, preload, poisonBin, poisonMarker, pathPoisonMarker, trustedMarker, angularMarker, spawnMarker };
}

function run(fixture: Fixture, env: NodeJS.ProcessEnv = {}) {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/^(?:path|npm_execpath)$/i.test(key)) delete childEnv[key];
  }
  return spawnSync(process.execPath, ['--require', fixture.preload, fixture.runner, 'build', '--stats-json'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...childEnv,
      PATH: [fixture.poisonBin, path.dirname(process.env.ComSpec || ''), path.dirname(process.execPath)].join(path.delimiter),
      npm_execpath: path.join(fixture.root, 'attacker', 'npm-cli.js'),
      NVM_DIR: path.join(fixture.root, 'missing-nvm'),
      ...env,
    },
  });
}

function expectUnavailable(fixture: Fixture, result: ReturnType<typeof run>, reason: string): void {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(reason);
  expect(result.stderr).not.toContain(fixture.root);
  expect(fs.existsSync(fixture.poisonMarker)).toBe(false);
  expect(fs.existsSync(fixture.pathPoisonMarker)).toBe(false);
  expect(fs.existsSync(fixture.angularMarker)).toBe(false);
}

describe('run-ng Windows Node 22 launcher integrity', () => {
  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it('uses only the co-located CLI and ignores CWD, PATH, and npm_execpath poisoning', () => {
    const fixture = createFixture();
    const result = run(fixture);

    expect(result.status).toBe(0);
    expect(fs.existsSync(fixture.poisonMarker)).toBe(false);
    expect(fs.existsSync(fixture.pathPoisonMarker)).toBe(false);
    expect(fs.existsSync(fixture.angularMarker)).toBe(true);
    expect(JSON.parse(fs.readFileSync(fixture.trustedMarker, 'utf8'))).toEqual([
      '-y', 'node@22.14.0', '--', path.join(fixture.root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'), 'build', '--stats-json',
    ]);
  });

  it.each([
    ['missing', 'run-ng-node22-launcher-unavailable'],
    ['directory', 'run-ng-node22-launcher-invalid'],
    ['symlink', 'run-ng-node22-launcher-invalid'],
    ['dangling', 'run-ng-node22-launcher-invalid'],
    ['junction', 'run-ng-node22-launcher-invalid'],
  ] as const)('fails closed for a %s launcher fixture', (candidate, reason) => {
    const fixture = createFixture(candidate);
    expectUnavailable(fixture, run(fixture), reason);
  });

  it('fails closed when the co-located CLI cannot be read', () => {
    const fixture = createFixture();
    expectUnavailable(fixture, run(fixture, { DENY_LAUNCHER: '1' }), 'run-ng-node22-launcher-unavailable');
  });

  it('fails closed when candidate resolution escapes the canonical runtime directory', () => {
    const fixture = createFixture();
    expectUnavailable(fixture, run(fixture, { ESCAPE_LAUNCHER: '1' }), 'run-ng-node22-launcher-invalid');
  });

  it('propagates trusted launcher failure without falling back to poisoned commands', () => {
    const fixture = createFixture('file', { trustedStatus: 7 });
    const result = run(fixture);
    expect(result.status).toBe(7);
    expect(fs.existsSync(fixture.poisonMarker)).toBe(false);
    expect(fs.existsSync(fixture.trustedMarker)).toBe(true);
  });

  it('preserves the direct Node 22 path and set-env failure behavior', () => {
    const direct = createFixture('missing');
    expect(run(direct, { FAKE_NODE_VERSION: '22.14.0' }).status).toBe(0);
    expect(fs.existsSync(direct.angularMarker)).toBe(true);
    const failedSetup = createFixture('file', { setEnvStatus: 9 });
    expect(run(failedSetup).status).toBe(9);
    expect(fs.existsSync(failedSetup.trustedMarker)).toBe(false);
  });

  it('preserves the non-Windows bare npx fallback', () => {
    const fixture = createFixture('missing');
    const result = run(fixture, { FAKE_PLATFORM: 'linux', MOCK_SPAWN: '1' });
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(fixture.spawnMarker, 'utf8'))).toEqual([
      'npx', ['-y', 'node@22.14.0', '--', path.join(fixture.root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'), 'build', '--stats-json'],
    ]);
  });
});
