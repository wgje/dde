import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const runnerPath = path.join(projectRoot, 'scripts', 'run-codegraph-adapter-gate.cjs');
const tempRoots: string[] = [];

function createFakeNpmCli(): { dir: string; cliPath: string; logPath: string; lingerPidPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-adapter-gate-'));
  tempRoots.push(dir);
  const cliPath = path.join(dir, 'fake-npm-cli.cjs');
  const logPath = path.join(dir, 'npm-calls.log');
  const lingerPidPath = path.join(dir, 'linger.pid');

  writeFileSync(cliPath, `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const scriptName = process.argv[3] ?? '';
fs.appendFileSync(process.env.FAKE_NPM_LOG, process.argv.slice(2).join(' ') + '\\n');
if (scriptName === process.env.FAKE_NPM_LINGER_ON) {
  const lingerMode = process.env.FAKE_NPM_LINGER_MODE ?? 'overlay';
  const lingerArgs = lingerMode === 'wrapper'
    ? [
      '-e',
      'setInterval(() => {}, 1000);',
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      'node_modules/@colbymchenry/codegraph/lib/dist/bin/codegraph.js',
      'serve',
      '--mcp',
      '--path',
      process.cwd(),
    ]
    : [
      '-e',
      'setInterval(() => {}, 1000);',
      'scripts/generate-codegraph-nanoflow-overlay.mjs',
    ];
  const child = spawn(process.execPath, [
    ...lingerArgs,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  fs.writeFileSync(process.env.FAKE_NPM_LINGER_PID, String(child.pid));
  child.unref();
}
if (scriptName === process.env.FAKE_NPM_FAIL_ON) {
  process.exit(Number(process.env.FAKE_NPM_FAIL_CODE ?? '7'));
}
process.exit(0);
`);

  return { dir, cliPath, logPath, lingerPidPath };
}

function createNoisyDirectPlan(): { dir: string; planPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-adapter-gate-'));
  tempRoots.push(dir);
  const scriptPath = path.join(dir, 'noisy-child.cjs');
  const planPath = path.join(dir, 'gate-plan.json');

  writeFileSync(scriptPath, `
for (let index = 0; index < 200; index += 1) {
  console.log('stdout-line-' + index);
  console.error('stderr-line-' + index);
}
process.exit(23);
`);
  writeFileSync(planPath, JSON.stringify([
    {
      name: 'noisy:failure',
      command: 'node',
      args: [scriptPath],
      captureOutput: true,
    },
  ], null, 2));

  return { dir, planPath };
}

function createSuccessfulCapturedDirectPlan(): { dir: string; planPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-adapter-gate-'));
  tempRoots.push(dir);
  const scriptPath = path.join(dir, 'successful-child.cjs');
  const planPath = path.join(dir, 'gate-plan.json');

  writeFileSync(scriptPath, "console.log('captured-success-output');\n");
  writeFileSync(planPath, JSON.stringify([
    {
      name: 'captured:success',
      command: 'node',
      args: [scriptPath],
      captureOutput: true,
    },
  ], null, 2));

  return { dir, planPath };
}

function runGateWithFakeNpm(
  options: { failOn?: string; failCode?: number; lingerOn?: string; lingerMode?: string } = {},
) {
  const fake = createFakeNpmCli();
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      NANOFLOW_CODEGRAPH_GATE_NPM_CLI: fake.cliPath,
      FAKE_NPM_LOG: fake.logPath,
      FAKE_NPM_FAIL_ON: options.failOn ?? '',
      FAKE_NPM_FAIL_CODE: String(options.failCode ?? 7),
      FAKE_NPM_LINGER_ON: options.lingerOn ?? '',
      FAKE_NPM_LINGER_MODE: options.lingerMode ?? 'overlay',
      FAKE_NPM_LINGER_PID: fake.lingerPidPath,
    },
  });

  const calls = readFileSync(fake.logPath, 'utf8').trim().split('\n').filter(Boolean);
  return { result, calls, fake };
}

function runGateWithPrintedPlan() {
  return spawnSync(process.execPath, [runnerPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NANOFLOW_CODEGRAPH_GATE_PRINT_PLAN: '1',
    },
  });
}

function runGateWithPrintPlanArgument() {
  return spawnSync(process.execPath, [runnerPath, '--print-plan'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runGateWithQuickPrintedPlan() {
  return spawnSync(process.execPath, [runnerPath, '--profile', 'quick', '--print-plan'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runGateWithPrintedPlanAndLogDir(logDir: string) {
  return spawnSync(process.execPath, [runnerPath, '--print-plan'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      NANOFLOW_CODEGRAPH_GATE_LOG_DIR: logDir,
    },
  });
}

function runGateWithPlanFile(
  planPath: string,
  logDir: string,
  envOverrides: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [runnerPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: Number(envOverrides.FAKE_GATE_RUNNER_TIMEOUT_MS ?? '10000'),
    env: {
      ...process.env,
      NANOFLOW_CODEGRAPH_GATE_PLAN_FILE: planPath,
      NANOFLOW_CODEGRAPH_GATE_LOG_DIR: logDir,
      NANOFLOW_CODEGRAPH_GATE_TAIL_CHARS: '600',
      ...envOverrides,
    },
  });
}

function createHangingDirectPlan(): { dir: string; planPath: string; pidPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-adapter-gate-'));
  tempRoots.push(dir);
  const scriptPath = path.join(dir, 'hanging-child.cjs');
  const planPath = path.join(dir, 'gate-plan.json');
  const pidPath = path.join(dir, 'hanging-child.pid');

  writeFileSync(scriptPath, `
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_HANGING_CHILD_PID, String(process.pid));
console.error('hanging-child-started');
setInterval(() => {}, 1000);
`);
  writeFileSync(planPath, JSON.stringify([
    {
      name: 'hanging:direct',
      command: 'node',
      args: [scriptPath],
      captureOutput: true,
    },
  ], null, 2));

  return { dir, planPath, pidPath };
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(pid: number, timeoutMs = 2000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    sleepSync(50);
  }
  return !isProcessAlive(pid);
}

function forceKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

describe('CodeGraph adapter gate runner', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the adapter gate scripts in order through one Node orchestrator', () => {
    const { result, calls } = runGateWithFakeNpm();

    expect(result.status).toBe(0);
    expect(calls).toEqual([
      'run codegraph:adapter:preflight',
      'run codegraph:overlay:validate',
      'run codegraph:adapter:infra:test',
      'run codegraph:adapter:context',
      'run codegraph:adapter:context:source-ordering',
      'run codegraph:adapter:context:angular-route-redirect',
      'run codegraph:adapter:context:host-binding',
      'run codegraph:adapter:context:edge-function-route',
      'run codegraph:adapter:context:dedup-boundary',
      'run codegraph:overlay:test',
      'run codegraph:mcp:smoke',
      'run codegraph:mcp:stale-smoke',
      'run codegraph:mcp:log:guard',
    ]);
  }, 60_000);

  it('stops at the first failing script and propagates the child exit code', () => {
    const { result, calls } = runGateWithFakeNpm({
      failOn: 'codegraph:overlay:test',
      failCode: 17,
    });

    expect(result.status).toBe(17);
    expect(calls).toEqual([
      'run codegraph:adapter:preflight',
      'run codegraph:overlay:validate',
      'run codegraph:adapter:infra:test',
      'run codegraph:adapter:context',
      'run codegraph:adapter:context:source-ordering',
      'run codegraph:adapter:context:angular-route-redirect',
      'run codegraph:adapter:context:host-binding',
      'run codegraph:adapter:context:edge-function-route',
      'run codegraph:adapter:context:dedup-boundary',
      'run codegraph:overlay:test',
    ]);
    expect(result.stderr).toContain('codegraph:overlay:test failed with exit code 17');
  }, 60_000);

  it('cleans up descendant processes left behind by a completed gate step', () => {
    const { result, fake } = runGateWithFakeNpm({
      lingerOn: 'codegraph:overlay:test',
    });
    const lingerPid = Number(readFileSync(fake.lingerPidPath, 'utf8'));

    try {
      expect(result.status).toBe(0);
      expect(waitForProcessExit(lingerPid)).toBe(true);
    } finally {
      forceKill(lingerPid);
    }
  }, 60_000);

  it('uses direct commands for long-running adapter steps instead of nested npm scripts', () => {
    const result = runGateWithPrintedPlan();

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.map((step: { name: string }) => step.name)).toEqual([
      'codegraph:adapter:preflight',
      'codegraph:adapter:doctor:strict',
      'codegraph:overlay:validate',
      'codegraph:adapter:infra:test',
      'codegraph:adapter:context',
      'codegraph:adapter:context:source-ordering',
      'codegraph:adapter:context:angular-route-redirect',
      'codegraph:adapter:context:host-binding',
      'codegraph:adapter:context:edge-function-route',
      'codegraph:adapter:context:dedup-boundary',
      'codegraph:adapter:context:packaged-artifacts',
      'codegraph:overlay:test',
      'codegraph:mcp:smoke',
      'codegraph:mcp:stale-smoke',
      'codegraph:mcp:log:guard',
    ]);
    expect(plan).toContainEqual({
      name: 'codegraph:adapter:infra:test',
      command: 'vitest',
      captureOutput: true,
      args: [
        'run',
        '--config',
        'vitest.config.mts',
        '--no-file-parallelism',
        '--maxWorkers',
        '1',
        'src/tests/scripts/analyze-codegraph-mcp-log.spec.ts',
        'src/tests/scripts/agent-file-lease.spec.ts',
        'src/tests/scripts/codegraph-adapter-doctor.spec.ts',
        'src/tests/scripts/codegraph-adapter-gate.spec.ts',
        'src/tests/scripts/codegraph-adapter-preflight.spec.ts',
        'src/tests/scripts/codegraph-mcp-smoke.spec.ts',
        'src/tests/scripts/codegraph-overlay-baseline-manifest.spec.ts',
        'src/tests/scripts/validate-codegraph-overlay-docs.spec.ts',
        'src/tests/scripts/validate-codegraph-overlay-docs-structured-counts.spec.ts',
      ],
    });
    expect(plan).toContainEqual({
      name: 'codegraph:adapter:context',
      command: 'node',
      captureOutput: true,
      args: [
        'scripts/codegraph-adapter-context.cjs',
        '--query',
        'scripts/codegraph-adapter-context.cjs parseArgs',
        '--overlay-query',
        'sync-required-field',
        '--overlay-limit',
        '5',
        '--overlay-query-limit',
        '5',
        '--json',
        '--timeout-ms',
        '90000',
      ],
    });
    expect(plan).toContainEqual({
      name: 'codegraph:adapter:context:source-ordering',
      command: 'node',
      captureOutput: true,
      args: [
        'scripts/codegraph-adapter-context.cjs',
        '--query',
        'session service',
        '--overlay-query',
        'session service',
        '--max-files',
        '1',
        '--overlay-limit',
        '8',
        '--overlay-query-limit',
        '8',
        '--json',
        '--require-overlay-match',
        '--timeout-ms',
        '90000',
      ],
    });
    expect(plan).toContainEqual({
      name: 'codegraph:adapter:context:angular-route-redirect',
      command: 'node',
      captureOutput: true,
      args: [
        'scripts/codegraph-adapter-context.cjs',
        '--query',
        'angular-route-redirect',
        '--overlay-query',
        'angular-route-redirect',
        '--max-files',
        '1',
        '--overlay-limit',
        '8',
        '--overlay-query-limit',
        '8',
        '--json',
        '--require-overlay-match',
        '--timeout-ms',
        '90000',
      ],
    });
    expect(plan).toContainEqual({
      name: 'codegraph:adapter:context:host-binding',
      command: 'node',
      captureOutput: true,
      args: [
        'scripts/codegraph-adapter-context.cjs',
        '--query',
        'host-binding',
        '--overlay-query',
        'host-binding',
        '--max-files',
        '1',
        '--overlay-limit',
        '8',
        '--overlay-query-limit',
        '8',
        '--json',
        '--require-overlay-match',
        '--timeout-ms',
        '90000',
      ],
    });
    expect(plan).toContainEqual({
      name: 'codegraph:adapter:context:edge-function-route',
      command: 'node',
      captureOutput: true,
      args: [
        'scripts/codegraph-adapter-context.cjs',
        '--query',
        'edge-function-route',
        '--overlay-query',
        'edge-function-route',
        '--max-files',
        '1',
        '--overlay-limit',
        '8',
        '--overlay-query-limit',
        '8',
        '--json',
        '--require-overlay-match',
        '--timeout-ms',
        '90000',
      ],
    });
    expect(plan).toContainEqual({
      name: 'codegraph:adapter:context:dedup-boundary',
      command: 'node',
      captureOutput: true,
      args: [
        'scripts/codegraph-adapter-context.cjs',
        '--query',
        'NanoFlow CodeGraph adaptation dedup contract source quality duplicated native behavior context pack source ordering adapter boundaries next gaps',
        '--overlay-query',
        'NanoFlow CodeGraph adaptation dedup contract source quality duplicated native behavior context pack source ordering adapter boundaries next gaps',
        '--max-files',
        '1',
        '--overlay-limit',
        '8',
        '--overlay-query-limit',
        '8',
        '--json',
        '--require-overlay-match',
        '--timeout-ms',
        '90000',
      ],
    });
    expect(plan).toContainEqual({
      name: 'codegraph:adapter:context:packaged-artifacts',
      command: 'vitest',
      captureOutput: true,
      args: [
        'run',
        '--config',
        'vitest.config.mts',
        'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
        '--testNamePattern',
        'minified bundles source maps and lockfiles',
      ],
    });
    expect(plan).toContainEqual({
      name: 'codegraph:overlay:test',
      command: 'vitest',
      captureOutput: true,
      args: [
        'run',
        '--config',
        'vitest.config.mts',
        'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
        'src/tests/scripts/codegraph-nanoflow-overlay-source-boundaries.spec.ts',
      ],
    });
    expect(plan.every((step: { command: string }) => step.command !== 'npm')).toBe(true);
  }, 15_000);

  it('prints the adapter gate plan from a CLI argument without running any step', () => {
    const result = runGateWithPrintPlanArgument();

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('[codegraph-adapter-gate] running');
    const plan = JSON.parse(result.stdout);
    expect(plan.map((step: { name: string }) => step.name)).toEqual([
      'codegraph:adapter:preflight',
      'codegraph:adapter:doctor:strict',
      'codegraph:overlay:validate',
      'codegraph:adapter:infra:test',
      'codegraph:adapter:context',
      'codegraph:adapter:context:source-ordering',
      'codegraph:adapter:context:angular-route-redirect',
      'codegraph:adapter:context:host-binding',
      'codegraph:adapter:context:edge-function-route',
      'codegraph:adapter:context:dedup-boundary',
      'codegraph:adapter:context:packaged-artifacts',
      'codegraph:overlay:test',
      'codegraph:mcp:smoke',
      'codegraph:mcp:stale-smoke',
      'codegraph:mcp:log:guard',
    ]);
  }, 15_000);

  it('prints a quick profile plan for fast agent preflight without the full overlay suite', () => {
    const result = runGateWithQuickPrintedPlan();

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.map((step: { name: string }) => step.name)).toEqual([
      'codegraph:adapter:preflight',
      'codegraph:adapter:doctor:strict',
      'codegraph:adapter:infra:test',
      'codegraph:adapter:context',
      'codegraph:adapter:context:source-ordering',
      'codegraph:adapter:context:angular-route-redirect',
      'codegraph:adapter:context:host-binding',
      'codegraph:adapter:context:edge-function-route',
      'codegraph:adapter:context:dedup-boundary',
      'codegraph:adapter:context:packaged-artifacts',
      'codegraph:mcp:smoke',
      'codegraph:mcp:stale-smoke',
      'codegraph:mcp:log:guard',
    ]);
    expect(plan.some((step: { name: string }) => step.name === 'codegraph:overlay:test')).toBe(false);
    const infraStep = plan.find((step: { name: string }) => step.name === 'codegraph:adapter:infra:test');
    expect(infraStep).toEqual(expect.objectContaining({
      command: 'vitest',
      captureOutput: true,
      args: expect.arrayContaining([
        'src/tests/scripts/analyze-codegraph-mcp-log.spec.ts',
        'src/tests/scripts/codegraph-adapter-doctor.spec.ts',
        'src/tests/scripts/codegraph-adapter-preflight.spec.ts',
        'src/tests/scripts/validate-codegraph-overlay-docs.spec.ts',
      ]),
    }));
    expect(infraStep.args).not.toContain('src/tests/scripts/codegraph-adapter-gate.spec.ts');
    expect(infraStep.args).not.toContain('src/tests/scripts/codegraph-mcp-smoke.spec.ts');
    const smokeStep = plan.find((step: { name: string }) => step.name === 'codegraph:mcp:smoke');
    expect(smokeStep.args).toEqual(expect.arrayContaining(['--repeat', '1']));
    expect(smokeStep.args).toEqual(expect.arrayContaining([
      '--query',
      'scripts/codegraph-adapter-context.cjs parseArgs',
      '--overlay-query',
      'sync-required-field',
    ]));
    expect(smokeStep.args).not.toContain('--codegraph-target');
    const staleSmokeStep = plan.find((step: { name: string }) => step.name === 'codegraph:mcp:stale-smoke');
    expect(staleSmokeStep).toEqual(expect.objectContaining({
      args: expect.arrayContaining([
        'scripts/smoke-codegraph-mcp-wrapper.cjs',
        '--codegraph-target',
        expect.stringContaining('fake-codegraph-mcp.cjs'),
        '--query',
        'scripts/codegraph-adapter-context.cjs parseArgs',
        '--overlay-query',
        'sync-required-field',
        '--simulate-stale-wrapper-script',
        '--overlay-limit',
        '1',
      ]),
      env: expect.objectContaining({
        NANOFLOW_CODEGRAPH_MCP_LOG: expect.stringContaining('codegraph-adapter-gate-stale-mcp-wrapper.log'),
      }),
    }));
  }, 15_000);

  it('runs strict doctor checks in both gate profiles before expensive adapter work', () => {
    const fullResult = runGateWithPrintedPlan();
    const quickResult = runGateWithQuickPrintedPlan();

    expect(fullResult.status, fullResult.stderr || fullResult.stdout).toBe(0);
    expect(quickResult.status, quickResult.stderr || quickResult.stdout).toBe(0);
    const fullPlan = JSON.parse(fullResult.stdout);
    const quickPlan = JSON.parse(quickResult.stdout);
    const strictDoctorStep = {
      name: 'codegraph:adapter:doctor:strict',
      command: 'node',
      args: ['scripts/codegraph-adapter-doctor.cjs', '--strict'],
    };

    expect(fullPlan).toContainEqual(strictDoctorStep);
    expect(quickPlan).toContainEqual(strictDoctorStep);
    expect(fullPlan.map((step: { name: string }) => step.name).slice(0, 3)).toEqual([
      'codegraph:adapter:preflight',
      'codegraph:adapter:doctor:strict',
      'codegraph:overlay:validate',
    ]);
    expect(quickPlan.map((step: { name: string }) => step.name).slice(0, 3)).toEqual([
      'codegraph:adapter:preflight',
      'codegraph:adapter:doctor:strict',
      'codegraph:adapter:infra:test',
    ]);
  }, 15_000);

  it('wires MCP smoke and log guard through a gate-owned fresh wrapper log', () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-adapter-gate-logs-'));
    tempRoots.push(logDir);
    const result = runGateWithPrintedPlanAndLogDir(logDir);

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    const smokeStep = plan.find((step: { name: string }) => step.name === 'codegraph:mcp:smoke');
    const staleSmokeStep = plan.find((step: { name: string }) => step.name === 'codegraph:mcp:stale-smoke');
    const logGuardStep = plan.find((step: { name: string }) => step.name === 'codegraph:mcp:log:guard');
    const expectedFreshLog = path.join(logDir, 'codegraph-adapter-gate-mcp-wrapper.log');
    const expectedStaleLog = path.join(logDir, 'codegraph-adapter-gate-stale-mcp-wrapper.log');

    expect(smokeStep).toEqual(expect.objectContaining({
      args: expect.not.arrayContaining(['--codegraph-target']),
      env: expect.objectContaining({
        NANOFLOW_CODEGRAPH_MCP_LOG: expectedFreshLog,
      }),
    }));
    expect(staleSmokeStep).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        NANOFLOW_CODEGRAPH_MCP_LOG: expectedStaleLog,
      }),
      args: expect.arrayContaining([
        '--codegraph-target',
        expect.stringContaining('fake-codegraph-mcp.cjs'),
        '--simulate-stale-wrapper-script',
      ]),
    }));
    expect(logGuardStep).toEqual(expect.objectContaining({
      args: expect.arrayContaining([
        expectedFreshLog,
        '--fail-on-current-source-ordering',
        '--fail-on-current-autosync-disabled',
        '--fail-on-active-stale-wrappers',
        '--fail-on-host-config-mismatch',
        '--fail-on-untrusted-direct-mcp',
      ]),
    }));
    expect(logGuardStep.args).not.toContain('.codegraph/nanoflow-mcp-wrapper.log');
    expect(logGuardStep.args).not.toContain(expect.stringContaining('codegraph-adapter-gate-stale-mcp-wrapper.log'));
    expect(logGuardStep.args).toContain('--fail-on-stale-current-wrapper');
  });

  it('uses repeated MCP smoke requests to catch long-running wrapper regressions', () => {
    const result = runGateWithPrintedPlan();

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    const smokeStep = plan.find((step: { name: string }) => step.name === 'codegraph:mcp:smoke');

    expect(smokeStep).toEqual(expect.objectContaining({
      args: expect.arrayContaining([
        'scripts/smoke-codegraph-mcp-wrapper.cjs',
        '--repeat',
        '5',
        '--overlay-limit',
        '60',
        '--overlay-query-limit',
        '60',
        '--timeout-ms',
        '90000',
      ]),
    }));
  }, 30_000);

  it('captures noisy direct command output to a log and reports a bounded failure tail', () => {
    const fake = createNoisyDirectPlan();
    const result = runGateWithPlanFile(fake.planPath, fake.dir);

    expect(result.status).toBe(23);
    expect(result.stdout).not.toContain('stdout-line-0');
    expect(result.stderr).toContain('noisy:failure failed with exit code 23');
    expect(result.stderr).toContain('output log:');
    expect(result.stderr).toContain('stderr-line-199');
    expect(result.stderr).not.toContain('stdout-line-0');

    const logPath = result.stderr.match(/output log: (.+)/)?.[1]?.trim();
    expect(logPath).toEqual(expect.any(String));
    expect(readFileSync(logPath as string, 'utf8')).toContain('stdout-line-0');
  }, 30_000);

  it('removes captured command logs after successful direct steps', () => {
    const fake = createSuccessfulCapturedDirectPlan();
    const result = runGateWithPlanFile(fake.planPath, fake.dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('running captured:success');
    expect(result.stderr).not.toContain('output log:');
    expect(existsSync(path.join(fake.dir, 'gate-plan.json'))).toBe(true);
    expect(readdirSync(fake.dir).filter(fileName => fileName.endsWith('.log'))).toEqual([]);
  }, 30_000);

  it('terminates a direct gate step that exceeds the configured timeout', () => {
    const fake = createHangingDirectPlan();
    const result = runGateWithPlanFile(fake.planPath, fake.dir, {
      NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS: '250',
      FAKE_HANGING_CHILD_PID: fake.pidPath,
      FAKE_GATE_RUNNER_TIMEOUT_MS: '12000',
    });
    const childPid = Number(readFileSync(fake.pidPath, 'utf8'));

    try {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('hanging:direct timed out after 250ms');
      expect(result.stderr).toContain('hanging-child-started');
      expect(waitForProcessExit(childPid)).toBe(true);
    } finally {
      forceKill(childPid);
    }
  }, 10_000);

  it('cleans up wrapper-like CodeGraph descendants left behind by MCP smoke', () => {
    const { result, fake } = runGateWithFakeNpm({
      lingerOn: 'codegraph:mcp:smoke',
      lingerMode: 'wrapper',
    });
    const lingerPid = Number(readFileSync(fake.lingerPidPath, 'utf8'));

    try {
      expect(result.status).toBe(0);
      expect(waitForProcessExit(lingerPid)).toBe(true);
    } finally {
      forceKill(lingerPid);
    }
  }, 60_000);
});
