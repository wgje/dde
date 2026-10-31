import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const matrixScript = path.join(process.cwd(), 'scripts', 'run-test-matrix.cjs');
const fixtureRoots: string[] = [];
const leakedPids = new Set<number>();
const matrixControlEnvKeys = new Set([
  'TEST_BASELINE_MAX_AGE_HOURS',
  'TEST_DURATION_BASELINE',
  'TEST_INCLUDE_QUARANTINE',
  'TEST_LANE_OVERRIDES',
  'TEST_LPT_REQUIRE_FRESH_BASELINE',
  'TEST_LPT_SCHEDULER',
  'TEST_MAX_PROCS',
  'TEST_MIN_FILE_ESTIMATES',
  'TEST_MODE',
  'TEST_QUARANTINE_FILE',
  'TEST_SHARD_INDEX',
  'TEST_SHARD_STRATEGY',
  'TEST_SHARDS',
  'TEST_TIMING_FILE',
  'TEST_TIMING_IN',
  'TEST_VITEST_JSON_OUT_DIR',
].map((key) => key.toLowerCase()));

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

function killExactProcess(pid: number): void {
  if (!isProcessAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      timeout: 5_000,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForDeath(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

async function cleanupOwnedProcess(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    killExactProcess(pid);
    if (await waitForDeath(pid)) {
      leakedPids.delete(pid);
      return true;
    }
  }
  return false;
}

function createFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-matrix-timeout-'));
  fixtureRoots.push(root);

  const specPath = path.join(root, 'src', 'services', 'fixture.service.spec.ts');
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, "describe('fixture', () => {});\n");

  const vitestPath = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  fs.mkdirSync(path.dirname(vitestPath), { recursive: true });
  fs.writeFileSync(vitestPath, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "if (process.env.MATRIX_STUB_MODE === 'hang') {",
    "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {",
    '    detached: false,',
    "    stdio: 'ignore',",
    '    windowsHide: true,',
    '  });',
    "  child.once('spawn', () => fs.writeFileSync(process.env.MATRIX_STUB_PID_FILE, String(child.pid)));",
    "  child.once('error', () => process.exit(92));",
    '  setTimeout(() => process.exit(0), Number(process.env.MATRIX_STUB_PARENT_EXIT_MS));',
    '  setInterval(() => {}, 1000);',
    '} else {',
    '  fs.writeFileSync(process.env.MATRIX_STUB_INVOCATION_FILE, JSON.stringify(process.argv.slice(2)));',
    '}',
    '',
  ].join('\n'));

  return root;
}

function runMatrix(
  root: string,
  mode: 'hang' | 'success',
  timeoutMs: number,
) {
  const timingPath = path.join(root, 'matrix-timing.json');
  const pidPath = path.join(root, 'grandchild.pid');
  const invocationPath = path.join(root, 'vitest-invocation.json');
  const env = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => !matrixControlEnvKeys.has(key.toLowerCase())),
  ) as NodeJS.ProcessEnv;
  Object.assign(env, {
    MATRIX_STUB_INVOCATION_FILE: invocationPath,
    MATRIX_STUB_MODE: mode,
    MATRIX_STUB_PARENT_EXIT_MS: '750',
    MATRIX_STUB_PID_FILE: pidPath,
    NANOFLOW_TEST_MATRIX_VITEST_TIMEOUT_MS: String(timeoutMs),
  });

  const result = spawnSync(process.execPath, [
    matrixScript,
    '--lane=lane_node_minimal',
    '--max-procs=1',
    `--timing-out=${timingPath}`,
  ], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 10_000,
    windowsHide: true,
  });

  return { invocationPath, pidPath, result, timingPath };
}

afterEach(async () => {
  for (const pid of [...leakedPids]) {
    await cleanupOwnedProcess(pid);
  }
  if (leakedPids.size > 0) {
    throw new Error('failed to clean matrix fixture descendant');
  }
  for (const root of fixtureRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('run-test-matrix Vitest segment timeout contract', () => {
  it('kills the owned Vitest process tree before returning a timeout', async () => {
    const root = createFixtureRoot();
    const { pidPath, result, timingPath } = runMatrix(root, 'hang', 500);

    let grandchildPid: number | null = null;
    if (fs.existsSync(pidPath)) {
      const parsedPid = Number(fs.readFileSync(pidPath, 'utf8'));
      if (Number.isInteger(parsedPid) && parsedPid > 0) {
        grandchildPid = parsedPid;
        leakedPids.add(parsedPid);
      }
    }

    try {
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('[test:run] vitest segment timed out after 500ms');
      expect(fs.existsSync(pidPath)).toBe(true);
      expect(grandchildPid).not.toBeNull();
      if (grandchildPid === null) throw new Error('descendant PID was not recorded');

      const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
      expect(timing.lanes[0].exitCode).toBe(1);
      expect(timing.lanes[0].segments[0].status).toBe('timed_out');
      expect(await waitForDeath(grandchildPid)).toBe(true);

      const runnerSource = fs.readFileSync(matrixScript, 'utf8');
      expect(runnerSource).toContain("detached: process.platform !== 'win32'");
      expect(runnerSource).toContain('process.kill(-pid, signal)');
    } finally {
      if (grandchildPid !== null) await cleanupOwnedProcess(grandchildPid);
    }
  }, 10_000);

  it('preserves successful Vitest execution', () => {
    const root = createFixtureRoot();
    const { invocationPath, result, timingPath } = runMatrix(root, 'success', 5_000);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(invocationPath, 'utf8'))).toContain(
      'src/services/fixture.service.spec.ts',
    );
    const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
    expect(timing.lanes[0].exitCode).toBe(0);
    expect(timing.lanes[0].segments[0].status).toBe('executed');
  });
});
