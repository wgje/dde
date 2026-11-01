import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const wrapperPath = path.join(repoRoot, 'scripts', 'codegraph-mcp-stdio.cjs');
const target = '@colbymchenry/codegraph@1.6.2';
const tempRoots: string[] = [];

interface ExitScenario {
  code: number | null;
  signal: NodeJS.Signals | null;
  beforeEof?: boolean;
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"').replace(/%/g, '^%').replace(/[&|<>^]/g, '^$&')}"`;
}

function expectedSpawn(): { command: string; args: string[] } {
  const root = realpathSync.native(repoRoot);
  const npxArgs = ['-y', target, 'serve', '--mcp', '--path', root];
  if (process.platform !== 'win32') return { command: 'npx', args: npxArgs };
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', ['npx', ...npxArgs].map(quoteCmdArg).join(' ')],
  };
}

function makePreload(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'codegraph-legacy-stdio-'));
  tempRoots.push(root);
  const preloadPath = path.join(root, 'strict-child.cjs');
  writeFileSync(preloadPath, `
'use strict';
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const childProcess = require('node:child_process');
childProcess.spawn = (command, args, options) => {
  const expected = JSON.parse(process.env.LEGACY_STDIO_EXPECTED_SPAWN);
  if (command !== expected.command || JSON.stringify(args) !== JSON.stringify(expected.args)) {
    throw new Error('unexpected codegraph spawn');
  }
  if (options.cwd !== process.cwd() || JSON.stringify(options.stdio) !== JSON.stringify(['pipe', 'pipe', 'pipe'])) {
    throw new Error('unexpected codegraph spawn options');
  }
  const scenario = JSON.parse(process.env.LEGACY_STDIO_EXIT_SCENARIO);
  const child = new EventEmitter();
  let exited = false;
  const emitExit = () => {
    if (exited) return;
    exited = true;
    child.emit('exit', scenario.code, scenario.signal);
  };
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
    final(callback) { callback(); setImmediate(emitExit); },
  });
  if (scenario.beforeEof) process.nextTick(emitExit);
  return child;
};
`);
  return preloadPath;
}

function runWrapper(scenario: ExitScenario) {
  const preloadPath = makePreload();
  return spawnSync(
    process.execPath,
    [wrapperPath, target, 'serve', '--mcp', '--path', repoRoot],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      input: '',
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${JSON.stringify(preloadPath)}`,
        LEGACY_STDIO_EXPECTED_SPAWN: JSON.stringify(expectedSpawn()),
        LEGACY_STDIO_EXIT_SCENARIO: JSON.stringify(scenario),
        LEGACY_STDIO_SECRET: 'must-not-appear',
      },
    },
  );
}

describe('codegraph legacy MCP stdio child exit', () => {
  afterEach(() => {
    while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
  });

  it.each([
    {
      label: 'nonzero',
      scenario: { code: 23, signal: null },
      diagnostic: 'exitCode=23 signal=null',
    },
    {
      label: 'signal',
      scenario: { code: null, signal: 'SIGTERM' as const },
      diagnostic: 'exitCode=null signal=SIGTERM',
    },
  ])('fails closed for a $label child exit after client EOF', ({ scenario, diagnostic }) => {
    const result = runWrapper(scenario);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe(
      `[codegraph-mcp-stdio] codegraph-child-shutdown-failure ${diagnostic}\n`,
    );
    expect(result.stderr).not.toContain(target);
    expect(result.stderr).not.toContain(repoRoot);
    expect(result.stderr).not.toContain('must-not-appear');
    expect(result.stdout).toBe('');
  });

  it('preserves a clean child exit after client EOF', () => {
    const result = runWrapper({ code: 0, signal: null });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('preserves a pre-EOF child exit code', () => {
    const result = runWrapper({ code: 23, signal: null, beforeEof: true });
    expect(result.status).toBe(23);
    expect(result.stderr).toBe('');
  });

  it('preserves invalid argv rejection before spawn', () => {
    const result = spawnSync(process.execPath, [wrapperPath], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('First argument must be a pinned');
  });
});
