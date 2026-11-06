import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const runnerPath = path.join(projectRoot, 'scripts', 'run-health-gate.cjs');
const tempRoots: string[] = [];
const dailyScripts = ['quality:baseline', 'perf:guard', 'docs:validate', 'codegraph:adapter:gate', 'typecheck', 'test:run'];
const strictScripts = ['quality:baseline:ratchet', ...dailyScripts.slice(1, -1), 'quality:guard:migration-dry-run', 'test:run:verify'];
const fullScripts = [...strictScripts.slice(0, -1), 'test:run:full', 'test:e2e'];
const toCalls = (scripts: string[]) => scripts.map((script) => `run ${script}`);
const dailyCalls = toCalls(dailyScripts);

function createFakeNpmCli(): {
  dir: string;
  cliPath: string;
  logPath: string;
  grandchildPidPath: string;
  noopCliPath: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'nanoflow-health-gate-'));
  tempRoots.push(dir);
  const cliPath = path.join(dir, 'fake-npm-cli.cjs');
  const logPath = path.join(dir, 'npm-calls.log');
  const grandchildPidPath = path.join(dir, 'grandchild.pid');
  const noopCliPath = path.join(dir, 'noop-npm-cli.cjs');

  writeFileSync(cliPath, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const scriptName = process.argv[3] ?? '';
fs.appendFileSync(process.env.FAKE_HEALTH_NPM_LOG, process.argv.slice(2).join(' ') + '\\n');
console.log('stdout from ' + scriptName);
console.error('stderr from ' + scriptName);
if (scriptName === process.env.FAKE_HEALTH_HANG_ON) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  fs.writeFileSync(process.env.FAKE_HEALTH_GRANDCHILD_PID_PATH, String(grandchild.pid));
  grandchild.once('exit', () => process.exit(0));
  setInterval(() => {}, 1000);
  return;
}
if (scriptName === process.env.FAKE_HEALTH_FAIL_ON) {
  process.exit(Number(process.env.FAKE_HEALTH_FAIL_CODE ?? '19'));
}
process.exit(0);
`);
  writeFileSync(noopCliPath, 'process.exit(0);\n');

  return { dir, cliPath, logPath, grandchildPidPath, noopCliPath };
}

function runHealthWithPrintedPlan(args: string[] = []) {
  return spawnSync(process.execPath, [runnerPath, '--print-plan', ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
  });
}

function runHealthWithFakeNpm(
  args: string[] = [],
  options: {
    env?: NodeJS.ProcessEnv;
    failOn?: string;
    failCode?: number;
    hangOn?: string;
    timeoutMs?: number;
  } = {},
) {
  const fake = createFakeNpmCli();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    NANOFLOW_HEALTH_GATE_STEP_TIMEOUT_MS: String(options.timeoutMs ?? 10_000),
    NANOFLOW_HEALTH_GATE_TAIL_CHARS: '500',
    FAKE_HEALTH_NPM_LOG: fake.logPath,
    FAKE_HEALTH_FAIL_ON: options.failOn ?? '',
    FAKE_HEALTH_FAIL_CODE: String(options.failCode ?? 19),
    FAKE_HEALTH_HANG_ON: options.hangOn ?? '',
    FAKE_HEALTH_GRANDCHILD_PID_PATH: fake.grandchildPidPath,
  };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_execpath') delete env[key];
  }
  env.npm_execpath = fake.cliPath;

  const result = spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 15_000,
    env,
  });
  const calls = existsSync(fake.logPath)
    ? readFileSync(fake.logPath, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  return {
    result,
    calls,
    grandchildPidPath: fake.grandchildPidPath,
    noopCliPath: fake.noopCliPath,
  };
}

function isProcessAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    const probe = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 5_000,
    });
    return probe.status === 0 && probe.stdout.includes(`"${pid}"`);
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

function forceKillOwnedProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000,
    });
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
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
    expect(plan.steps.map((step: { script: string }) => step.script)).toEqual(dailyScripts);
  });

  it('uses the ratcheted baseline for the strict health plan', () => {
    const result = runHealthWithPrintedPlan(['--mode=strict']);

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.mode).toBe('strict');
    expect(plan.steps.map((step: { script: string }) => step.script)).toEqual(strictScripts);
  });

  it('uses full tests and e2e for the full health plan', () => {
    const result = runHealthWithPrintedPlan(['--mode=full']);

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.mode).toBe('full');
    expect(plan.steps.map((step: { script: string }) => step.script)).toEqual(fullScripts);
  });

  it.each([['strict', strictScripts], ['full', fullScripts]] as const)('executes the %s plan in order', (mode, scripts) => {
    const { result, calls } = runHealthWithFakeNpm([`--mode=${mode}`]);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual(toCalls([...scripts]));
  }, 20_000);

  it('stops strict health at migration evidence failure before its matrix', () => {
    const { result, calls } = runHealthWithFakeNpm(['--mode=strict'], {
      failOn: 'quality:guard:migration-dry-run',
      failCode: 29,
    });
    expect(result.status).toBe(29);
    expect(calls).toEqual(toCalls(strictScripts.slice(0, -1)));
    expect(result.stderr).toContain('[health-gate] FAIL migration dry-run evidence');
    expect(result.stderr).not.toContain('test:run:verify');
  }, 20_000);

  it('runs the daily health scripts in order through one runner', () => {
    const { result, calls } = runHealthWithFakeNpm();

    expect(result.status).toBe(0);
    expect(calls).toEqual(dailyCalls);
    expect(result.stderr).toContain('[health-gate] PASS quality baseline');
    expect(result.stderr).toContain('[health-gate] health gate passed');
  }, 20_000);

  it('ignores inherited health-gate print-plan control and executes the plan', () => {
    const { result, calls } = runHealthWithFakeNpm([], {
      env: { NANOFLOW_HEALTH_GATE_PRINT_PLAN: '1' },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual(dailyCalls);
  }, 20_000);

  it('ignores inherited health-gate npm-cli override and uses npm_execpath', () => {
    const fake = createFakeNpmCli();
    const { result, calls } = runHealthWithFakeNpm([], {
      env: { NANOFLOW_HEALTH_GATE_NPM_CLI: fake.noopCliPath },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual(dailyCalls);
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

  it('kills a timed-out npm process tree before returning and never advances the plan', async () => {
    let grandchildPid: number | null = null;

    try {
      const { result, calls, grandchildPidPath } = runHealthWithFakeNpm([], {
        hangOn: 'quality:baseline',
        timeoutMs: 200,
      });
      grandchildPid = existsSync(grandchildPidPath)
        ? Number.parseInt(readFileSync(grandchildPidPath, 'utf8'), 10)
        : null;

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('[health-gate] FAIL quality baseline');
      expect(result.stderr).toContain('signal TIMEOUT');
      expect(calls).toEqual(['run quality:baseline']);
      expect(existsSync(grandchildPidPath)).toBe(true);
      expect(Number.isInteger(grandchildPid) && Number(grandchildPid) > 0).toBe(true);
      expect(await waitForProcessExit(Number(grandchildPid))).toBe(true);
    } finally {
      if (grandchildPid !== null) {
        forceKillOwnedProcess(grandchildPid);
        await waitForProcessExit(grandchildPid);
      }
    }
  }, 20_000);

  it('uses an owned process-tree primitive for timeout cleanup', () => {
    const runnerSource = readFileSync(runnerPath, 'utf8');

    if (process.platform === 'win32') {
      expect(runnerSource).toContain("spawn('taskkill', ['/PID', String(pid), '/T', '/F']");
      expect(runnerSource).toContain('shell: false');
      expect(runnerSource).toContain('windowsHide: true');
      return;
    }

    expect(runnerSource).toContain("process.kill(-pid, signal)");
    expect(runnerSource).toContain("detached: process.platform !== 'win32'");
  });
});
