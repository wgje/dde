import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const runnerPath = path.join(projectRoot, 'scripts', 'run-health-gate.cjs');
const tempRoots: string[] = [];

function createFakeNpmCli(): { dir: string; cliPath: string; logPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'nanoflow-health-gate-'));
  tempRoots.push(dir);
  const cliPath = path.join(dir, 'fake-npm-cli.cjs');
  const logPath = path.join(dir, 'npm-calls.log');

  writeFileSync(cliPath, `
const fs = require('node:fs');
const scriptName = process.argv[3] ?? '';
fs.appendFileSync(process.env.FAKE_HEALTH_NPM_LOG, process.argv.slice(2).join(' ') + '\\n');
console.log('stdout from ' + scriptName);
console.error('stderr from ' + scriptName);
if (scriptName === process.env.FAKE_HEALTH_FAIL_ON) {
  process.exit(Number(process.env.FAKE_HEALTH_FAIL_CODE ?? '19'));
}
process.exit(0);
`);

  return { dir, cliPath, logPath };
}

function runHealthWithPrintedPlan(args: string[] = []) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NANOFLOW_HEALTH_GATE_PRINT_PLAN: '1',
    },
  });
}

function runHealthWithFakeNpm(
  args: string[] = [],
  options: { failOn?: string; failCode?: number } = {},
) {
  const fake = createFakeNpmCli();
  const result = spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NANOFLOW_HEALTH_GATE_NPM_CLI: fake.cliPath,
      NANOFLOW_HEALTH_GATE_TAIL_CHARS: '500',
      FAKE_HEALTH_NPM_LOG: fake.logPath,
      FAKE_HEALTH_FAIL_ON: options.failOn ?? '',
      FAKE_HEALTH_FAIL_CODE: String(options.failCode ?? 19),
    },
  });
  const calls = readFileSync(fake.logPath, 'utf8').trim().split('\n').filter(Boolean);
  return { result, calls };
}

describe('health gate runner', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints the daily health plan in the repository gate order', () => {
    const result = runHealthWithPrintedPlan();

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.mode).toBe('daily');
    expect(plan.steps.map((step: { script: string }) => step.script)).toEqual([
      'quality:baseline',
      'perf:guard',
      'docs:validate',
      'codegraph:adapter:gate',
      'typecheck',
      'test:run',
    ]);
  });

  it('uses the ratcheted baseline for the strict health plan', () => {
    const result = runHealthWithPrintedPlan(['--mode=strict']);

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.mode).toBe('strict');
    expect(plan.steps.map((step: { script: string }) => step.script)).toEqual([
      'quality:baseline:ratchet',
      'perf:guard',
      'docs:validate',
      'codegraph:adapter:gate',
      'typecheck',
      'test:run:verify',
    ]);
  });

  it('uses full tests and e2e for the full health plan', () => {
    const result = runHealthWithPrintedPlan(['--mode=full']);

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.mode).toBe('full');
    expect(plan.steps.map((step: { script: string }) => step.script)).toEqual([
      'quality:baseline:ratchet',
      'perf:guard',
      'docs:validate',
      'codegraph:adapter:gate',
      'typecheck',
      'test:run:full',
      'test:e2e',
    ]);
  });

  it('runs the daily health scripts in order through one runner', () => {
    const { result, calls } = runHealthWithFakeNpm();

    expect(result.status).toBe(0);
    expect(calls).toEqual([
      'run quality:baseline',
      'run perf:guard',
      'run docs:validate',
      'run codegraph:adapter:gate',
      'run typecheck',
      'run test:run',
    ]);
    expect(result.stderr).toContain('[health-gate] PASS quality baseline');
    expect(result.stderr).toContain('[health-gate] health gate passed');
  }, 20_000);

  it('stops at the first failing script and reports command plus stdout/stderr tails', () => {
    const { result, calls } = runHealthWithFakeNpm([], {
      failOn: 'docs:validate',
      failCode: 27,
    });

    expect(result.status).toBe(27);
    expect(calls).toEqual([
      'run quality:baseline',
      'run perf:guard',
      'run docs:validate',
    ]);
    expect(result.stderr).toContain('[health-gate] FAIL documentation gate');
    expect(result.stderr).toContain('command: npm run docs:validate');
    expect(result.stderr).toContain('stdout tail:');
    expect(result.stderr).toContain('stdout from docs:validate');
    expect(result.stderr).toContain('stderr tail:');
    expect(result.stderr).toContain('stderr from docs:validate');
    expect(result.stderr).not.toContain('test:run');
  }, 20_000);
});
