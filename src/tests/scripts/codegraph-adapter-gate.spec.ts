import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const runnerPath = path.join(projectRoot, 'scripts', 'run-codegraph-adapter-gate.cjs');
const tempRoots: string[] = [];
const LEGACY_CONTROL_KEYS = [
  'NANOFLOW_CODEGRAPH_GATE_PLAN_FILE',
  'NANOFLOW_CODEGRAPH_GATE_NPM_CLI',
  'NANOFLOW_CODEGRAPH_GATE_PROFILE',
  'NANOFLOW_CODEGRAPH_GATE_PRINT_PLAN',
] as const;
const FULL_STEP_NAMES = [
  'codegraph:adapter:preflight',
  'codegraph:adapter:doctor:pre-generation',
  'codegraph:overlay:sync',
  'codegraph:overlay:validate',
  'codegraph:adapter:doctor:post-generation:strict',
  'codegraph:adapter:infra:test',
  'codegraph:tooling:dependency-closure',
  'codegraph:adapter:context',
  'codegraph:adapter:context:source-ordering',
  'codegraph:adapter:context:angular-route-redirect',
  'codegraph:adapter:context:host-binding',
  'codegraph:adapter:context:edge-function-route',
  'codegraph:adapter:context:dedup-boundary',
  'codegraph:adapter:context:packaged-artifacts',
  'codegraph:overlay:test',
  'codegraph:overlay:docs:test',
  'codegraph:mcp:smoke',
  'codegraph:mcp:stale-smoke',
  'codegraph:mcp:log:guard',
  'codegraph:adapter:doctor:final-seal',
];
const QUICK_STEP_NAMES = [
  'codegraph:adapter:preflight',
  'codegraph:adapter:doctor:post-generation:strict',
  'codegraph:overlay:validate',
  'codegraph:adapter:infra:test',
  'codegraph:tooling:dependency-closure',
  'codegraph:adapter:context',
  'codegraph:adapter:context:source-ordering',
  'codegraph:adapter:context:angular-route-redirect',
  'codegraph:adapter:context:host-binding',
  'codegraph:adapter:context:edge-function-route',
  'codegraph:adapter:context:dedup-boundary',
  'codegraph:adapter:context:packaged-artifacts',
  'codegraph:overlay:docs:test',
  'codegraph:mcp:smoke',
  'codegraph:mcp:stale-smoke',
  'codegraph:mcp:log:guard',
];
const FORMAL_PLAN_DIGESTS = {
  full: 'f2dd58124160d2b4cb97f70af0e73d32b67847eb0d42ac5eaa3f7c53929b474e',
  quick: '17f46b8d76ad9dbd332ac31f0b9ee369ac44c18db9d60561afef2fd406927454',
};
const STUBBED_NODE_SCRIPTS = [
  'scripts/codegraph-adapter-preflight.cjs',
  'scripts/codegraph-adapter-doctor.cjs',
  'scripts/generate-codegraph-nanoflow-overlay.mjs',
  'scripts/sync-codegraph-overlay-docs.cjs',
  'scripts/run-codegraph-overlay-stability.cjs',
  'scripts/validate-codegraph-overlay-docs.cjs',
  'scripts/codegraph-adapter-context.cjs',
  'scripts/smoke-codegraph-mcp-wrapper.cjs',
  'scripts/analyze-codegraph-mcp-log.cjs',
  'scripts/fake-codegraph-mcp.cjs',
  'node_modules/vitest/vitest.mjs',
];

interface CommandSpec {
  command: 'node' | 'vitest';
  args: string[];
  captureOutput?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
}

interface GateStep extends CommandSpec {
  name: string;
  commands?: CommandSpec[];
}

interface InvocationRecord {
  execPath: string;
  script: string;
  args: string[];
  mcpLog: string | null;
}

interface GateHarness {
  root: string;
  runner: string;
  invocationLog: string;
  logDir: string;
  poisonCli: string;
  poisonCanary: string;
  directPid: string;
  descendantPid: string;
}

const STUB_RUNTIME = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const script = path.relative(process.cwd(), process.argv[1]).replace(/\\/g, '/');
const args = process.argv.slice(2);
const invocation = {
  execPath: process.execPath,
  script,
  args,
  mcpLog: process.env.NANOFLOW_CODEGRAPH_MCP_LOG ?? null,
};
fs.appendFileSync(process.env.STUB_INVOCATION_LOG, JSON.stringify(invocation) + '\n');
if (process.env.STUB_DIRECT_PID) {
  fs.writeFileSync(process.env.STUB_DIRECT_PID, String(process.pid));
}
function matches(name) {
  const selector = process.env[name];
  return Boolean(selector && (script === selector || JSON.stringify(args).includes(selector)));
}
if (matches('STUB_DESCENDANT_MATCH')) {
  const child = spawn(process.execPath, [
    '-e', 'setInterval(() => {}, 1000);',
    'scripts/codegraph-nanoflow-mcp-stdio.cjs',
    'node_modules/@colbymchenry/codegraph/lib/dist/bin/codegraph.js',
    'serve', '--mcp', '--path', process.cwd(),
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', error => {
    console.error(error.message);
    process.exit(91);
  });
  child.once('spawn', () => {
    fs.writeFileSync(process.env.STUB_DESCENDANT_PID, String(child.pid));
    child.unref();
    if (process.env.STUB_HOLD_AFTER_DESCENDANT === '1') {
      setInterval(() => {}, 1000);
    } else {
      process.exit(0);
    }
  });
} else if (matches('STUB_NOISE_MATCH')) {
  for (let index = 0; index < 200; index += 1) {
    console.log('stdout-line-' + index);
    console.error('stderr-line-' + index);
  }
  process.exit(Number(process.env.STUB_EXIT_CODE ?? '23'));
} else if (matches('STUB_DELAY_MATCH')) {
  setTimeout(() => process.exit(0), Number(process.env.STUB_DELAY_MS ?? '500'));
} else if (matches('STUB_FAIL_MATCH')) {
  process.exit(Number(process.env.STUB_EXIT_CODE ?? '17'));
} else {
  process.exit(0);
}
`;

function createHarness(): GateHarness {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-adapter-gate-'));
  tempRoots.push(root);
  const scriptsDir = path.join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const runner = path.join(scriptsDir, 'run-codegraph-adapter-gate.cjs');
  copyFileSync(runnerPath, runner);

  const stubRuntime = path.join(root, 'stub-gate-command.cjs');
  writeFileSync(stubRuntime, STUB_RUNTIME);
  for (const relativePath of STUBBED_NODE_SCRIPTS) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    const relativeRuntime = path.relative(path.dirname(target), stubRuntime).replace(/\\/g, '/');
    const specifier = relativeRuntime.startsWith('.') ? relativeRuntime : `./${relativeRuntime}`;
    writeFileSync(
      target,
      relativePath.endsWith('.mjs')
        ? `import ${JSON.stringify(specifier)};\n`
        : `require(${JSON.stringify(specifier)});\n`,
    );
  }

  const poisonCli = path.join(root, 'poisoned-npm-cli.cjs');
  const poisonCanary = path.join(root, 'poisoned-npm-cli.invoked');
  writeFileSync(
    poisonCli,
    "require('node:fs').writeFileSync(process.env.STUB_NPM_POISON_CANARY, 'invoked');\n",
  );
  return {
    root,
    runner,
    invocationLog: path.join(root, 'invocations.jsonl'),
    logDir: path.join(root, 'tmp', 'codegraph-adapter-gate'),
    poisonCli,
    poisonCanary,
    directPid: path.join(root, 'direct.pid'),
    descendantPid: path.join(root, 'descendant.pid'),
  };
}

function hermeticEnvironment(
  harness: GateHarness,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    const upper = key.toUpperCase();
    return !upper.startsWith('NANOFLOW_CODEGRAPH_GATE_')
      && upper !== 'NANOFLOW_CODEGRAPH_MCP_LOG'
      && upper !== 'NPM_EXECPATH'
      && !upper.startsWith('STUB_');
  }));
  return {
    ...env,
    NANOFLOW_CODEGRAPH_GATE_DISABLE_CLEANUP: '1',
    NANOFLOW_CODEGRAPH_GATE_LOG_DIR: harness.logDir,
    STUB_INVOCATION_LOG: harness.invocationLog,
    STUB_NPM_POISON_CANARY: harness.poisonCanary,
    STUB_DIRECT_PID: harness.directPid,
    STUB_DESCENDANT_PID: harness.descendantPid,
    npm_execpath: harness.poisonCli,
    ...overrides,
  };
}

function runGateUsingDefaultLogDir(harness: GateHarness, args: string[]) {
  const env = hermeticEnvironment(harness);
  delete env.NANOFLOW_CODEGRAPH_GATE_LOG_DIR;
  return spawnSync(process.execPath, [harness.runner, ...args], {
    cwd: harness.root,
    encoding: 'utf8',
    timeout: 60_000,
    env,
  });
}

function runGate(
  harness: GateHarness,
  args: string[] = [],
  overrides: Record<string, string> = {},
  timeout = 60_000,
) {
  return spawnSync(process.execPath, [harness.runner, ...args], {
    cwd: harness.root,
    encoding: 'utf8',
    timeout,
    env: hermeticEnvironment(harness, overrides),
  });
}

function readInvocations(harness: GateHarness): InvocationRecord[] {
  if (!existsSync(harness.invocationLog)) return [];
  return readFileSync(harness.invocationLog, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function readPlan(harness: GateHarness, profile: 'full' | 'quick'): GateStep[] {
  const args = profile === 'full'
    ? ['--print-plan']
    : ['--profile', 'quick', '--print-plan'];
  const result = runGate(harness, args);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout);
}

function normalizePlanValue(value: unknown, root: string): unknown {
  if (Array.isArray(value)) return value.map(item => normalizePlanValue(item, root));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizePlanValue(item, root)]),
    );
  }
  if (typeof value !== 'string') return value;
  const normalizedRoot = root.replace(/\\/g, '/');
  return value.replace(/\\/g, '/').split(normalizedRoot).join('<ROOT>');
}

function planDigest(plan: GateStep[], root: string): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizePlanValue(plan, root)))
    .digest('hex');
}

function expectedInvocations(plan: GateStep[]): InvocationRecord[] {
  return plan.flatMap(step => (step.commands ?? [step]).map((command) => {
    const isNode = command.command === 'node';
    return {
      execPath: process.execPath,
      script: isNode ? command.args[0].replace(/\\/g, '/') : 'node_modules/vitest/vitest.mjs',
      args: isNode ? command.args.slice(1) : command.args,
      mcpLog: command.env?.NANOFLOW_CODEGRAPH_MCP_LOG ?? null,
    };
  }));
}

function mixedCase(value: string): string {
  return [...value].map((character, index) => (
    index % 2 === 0 ? character.toLowerCase() : character.toUpperCase()
  )).join('');
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function removeTempRoot(root: string): void {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '') || Date.now() >= deadline) {
        throw error;
      }
      sleepSync(50);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(pid: number, timeoutMs = 4_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
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

function createBudgetExhaustingPwshShim(harness: GateHarness): {
  countFile: string;
} {
  const binDir = path.join(harness.root, 'pwsh-shim');
  const countFile = path.join(harness.root, 'pwsh-shim-count.txt');
  mkdirSync(binDir, { recursive: true });
  const sourcePath = path.join(binDir, 'PwshShim.cs');
  const executablePath = path.join(harness.root, 'pwsh.exe');
  writeFileSync(sourcePath, String.raw`using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class PwshShim {
  const uint QueryLimitedInformation = 0x1000;
  [StructLayout(LayoutKind.Sequential)]
  struct FileTime { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

  static ulong CreationIdentity(uint processId) {
    IntPtr process = OpenProcess(QueryLimitedInformation, false, processId);
    if (process == IntPtr.Zero) throw new InvalidOperationException("OpenProcess failed: " + Marshal.GetLastWin32Error());
    try {
      FileTime creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
        throw new InvalidOperationException("GetProcessTimes failed: " + Marshal.GetLastWin32Error());
      }
      return ((ulong)creation.High << 32) | creation.Low;
    } finally {
      CloseHandle(process);
    }
  }

  public static int Main(string[] args) {
    string countFile = Environment.GetEnvironmentVariable("STUB_PWSH_COUNT_FILE");
    int count = File.Exists(countFile) ? Int32.Parse(File.ReadAllText(countFile).Trim()) : 0;
    count += 1;
    File.WriteAllText(countFile, count.ToString());
    if (count == 1) {
      Console.WriteLine("[]");
      return 0;
    }
    if (count == 2 || count == 4) {
      Thread.Sleep(10000);
      return 0;
    }
    if (count == 3) {
      string descendant = File.ReadAllText(Environment.GetEnvironmentVariable("STUB_DESCENDANT_PID")).Trim();
      string direct = File.ReadAllText(Environment.GetEnvironmentVariable("STUB_DIRECT_PID")).Trim();
      ulong identity = CreationIdentity(UInt32.Parse(descendant));
      if (Environment.GetEnvironmentVariable("STUB_PWSH_IDENTITY_MODE") == "mismatch") identity += 1;
      Console.WriteLine("[{\"ProcessId\":" + descendant + ",\"ParentProcessId\":" + direct + ",\"CreationFileTime\":\"" + identity + "\",\"CommandLine\":\"\"}]");
      return 0;
    }
    Console.WriteLine("[]");
    return 0;
  }
}
`);
  const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const compile = spawnSync('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Add-Type -Path ${psQuote(sourcePath)} -OutputAssembly ${psQuote(executablePath)} -OutputType ConsoleApplication`,
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (compile.status !== 0 || compile.error) {
    throw new Error(`failed to compile pwsh shim: ${compile.stderr || compile.error?.message}`);
  }
  return {
    countFile,
  };
}

describe('CodeGraph adapter gate runner', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) removeTempRoot(root);
    }
  });

  it('locks the byte-semantic full and quick plans while print mode stays side-effect free', () => {
    const fullHarness = createHarness();
    const quickHarness = createHarness();
    const fullPlan = readPlan(fullHarness, 'full');
    const quickPlan = readPlan(quickHarness, 'quick');

    expect(fullPlan.map(step => step.name)).toEqual(FULL_STEP_NAMES);
    expect(quickPlan.map(step => step.name)).toEqual(QUICK_STEP_NAMES);
    expect(fullPlan[1]).toEqual({
      name: 'codegraph:adapter:doctor:pre-generation',
      command: 'node',
      args: ['scripts/codegraph-adapter-doctor.cjs', '--phase', 'pre-generation'],
    });
    expect(fullPlan[2]).toEqual({
      name: 'codegraph:overlay:sync',
      commands: [
        {
          command: 'node',
          args: ['scripts/run-codegraph-overlay-stability.cjs'],
          timeoutMs: 20 * 60 * 1000,
        },
        {
          command: 'node',
          args: ['scripts/sync-codegraph-overlay-docs.cjs'],
          timeoutMs: 10 * 60 * 1000,
        },
      ],
    });
    expect(fullPlan.find(step => step.name === 'codegraph:overlay:validate')?.commands).toEqual([
      {
        command: 'node',
        args: ['scripts/sync-codegraph-overlay-docs.cjs', '--assert-clean'],
        timeoutMs: 30_000,
      },
      {
        command: 'node',
        args: ['scripts/validate-codegraph-overlay-docs.cjs'],
        timeoutMs: 10 * 60 * 1000,
      },
    ]);
    expect(fullPlan[4]).toEqual({
      name: 'codegraph:adapter:doctor:post-generation:strict',
      command: 'node',
      args: ['scripts/codegraph-adapter-doctor.cjs', '--phase', 'post-generation', '--strict'],
    });
    expect(fullPlan.at(-1)).toEqual({
      name: 'codegraph:adapter:doctor:final-seal',
      command: 'node',
      args: ['scripts/codegraph-adapter-doctor.cjs', '--phase', 'post-generation', '--strict'],
    });
    expect(quickPlan[1]).toEqual({
      name: 'codegraph:adapter:doctor:post-generation:strict',
      command: 'node',
      args: ['scripts/codegraph-adapter-doctor.cjs', '--phase', 'post-generation', '--strict'],
    });
    expect(quickPlan[2]).toEqual({
      name: 'codegraph:overlay:validate',
      command: 'node',
      args: ['scripts/validate-codegraph-overlay-docs.cjs'],
      timeoutMs: 10 * 60 * 1000,
    });
    const quickCommandText = expectedInvocations(quickPlan)
      .map(call => `${call.script} ${call.args.join(' ')}`)
      .join('\n');
    for (const forbidden of [
      'generate-codegraph-nanoflow-overlay',
      'run-codegraph-overlay-stability',
      'sync-codegraph-overlay-docs',
      '--cleanup-stale-wrappers',
      '--repair-config',
    ]) {
      expect(quickCommandText).not.toContain(forbidden);
    }
    expect(expectedInvocations(fullPlan)).toHaveLength(22);
    expect(expectedInvocations(quickPlan)).toHaveLength(16);
    expect(planDigest(fullPlan, fullHarness.root)).toBe(FORMAL_PLAN_DIGESTS.full);
    expect(planDigest(quickPlan, quickHarness.root)).toBe(FORMAL_PLAN_DIGESTS.quick);
    for (const harness of [fullHarness, quickHarness]) {
      expect(existsSync(harness.logDir)).toBe(false);
      expect(readInvocations(harness)).toEqual([]);
      expect(existsSync(harness.poisonCanary)).toBe(false);
    }
  });

  it('creates a private per-run system-temp log directory while an explicit override wins', () => {
    const defaultRuns = [createHarness(), createHarness()].map((harness) => {
      const result = runGateUsingDefaultLogDir(harness, ['--print-plan']);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const plan = JSON.parse(result.stdout) as GateStep[];
      const logDirs = [...new Set(expectedInvocations(plan)
        .map(call => call.mcpLog)
        .filter((value): value is string => Boolean(value))
        .map(logPath => path.dirname(logPath)))];
      expect(logDirs).toHaveLength(1);
      return { harness, logDir: logDirs[0] };
    });
    expect(defaultRuns[0].logDir).not.toBe(defaultRuns[1].logDir);
    for (const { harness, logDir } of defaultRuns) {
      const relative = path.relative(tmpdir(), logDir);
      expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);
      expect(path.basename(logDir)).toMatch(/^nanoflow-codegraph-adapter-gate-/);
      expect(path.resolve(logDir).startsWith(path.resolve(harness.root))).toBe(false);
      expect(existsSync(logDir)).toBe(true);
      if (process.platform !== 'win32') {
        expect(statSync(logDir).mode & 0o077).toBe(0);
      }
      tempRoots.push(logDir);
    }

    const explicitHarness = createHarness();
    const explicitLogDir = path.join(explicitHarness.root, 'explicit-gate-logs');
    const explicitResult = runGate(explicitHarness, ['--print-plan'], {
      NANOFLOW_CODEGRAPH_GATE_LOG_DIR: explicitLogDir,
    });
    expect(explicitResult.status, explicitResult.stderr || explicitResult.stdout).toBe(0);
    const explicitLogs = expectedInvocations(JSON.parse(explicitResult.stdout))
      .map(call => call.mcpLog)
      .filter((value): value is string => Boolean(value));
    expect(explicitLogs).toEqual(expect.arrayContaining([
      path.join(explicitLogDir, 'codegraph-adapter-gate-mcp-wrapper.log'),
      path.join(explicitLogDir, 'codegraph-adapter-gate-stale-mcp-wrapper.log'),
    ]));
  });

  it('fails quick immediately at stale post-generation freshness with the exact sync hint', () => {
    const harness = createHarness();
    const result = runGate(harness, ['--profile', 'quick'], {
      STUB_FAIL_MATCH: 'scripts/codegraph-adapter-doctor.cjs',
      STUB_EXIT_CODE: '17',
    });

    expect(result.status).toBe(17);
    expect(result.stderr).toContain('npm run codegraph:overlay:sync');
    expect(readInvocations(harness).map(call => call.script)).toEqual([
      'scripts/codegraph-adapter-preflight.cjs',
      'scripts/codegraph-adapter-doctor.cjs',
    ]);
  });

  it('emits the sync hint when quick read-only validation detects stale generated state', () => {
    const harness = createHarness();
    const result = runGate(harness, ['--profile', 'quick'], {
      STUB_FAIL_MATCH: 'scripts/validate-codegraph-overlay-docs.cjs',
      STUB_EXIT_CODE: '19',
    });

    expect(result.status).toBe(19);
    expect(result.stderr).toContain('codegraph:overlay:validate failed with exit code 19');
    expect(result.stderr).toContain('npm run codegraph:overlay:sync');
    expect(readInvocations(harness).map(call => call.script)).toEqual([
      'scripts/codegraph-adapter-preflight.cjs',
      'scripts/codegraph-adapter-doctor.cjs',
      'scripts/validate-codegraph-overlay-docs.cjs',
    ]);
  });

  it('preserves an ordinary quick test failure without emitting the stale sync hint', () => {
    const harness = createHarness();
    const result = runGate(harness, ['--profile', 'quick'], {
      STUB_FAIL_MATCH: 'src/tests/scripts/codegraph-adapter-preflight.spec.ts',
      STUB_EXIT_CODE: '29',
    });

    expect(result.status).toBe(29);
    expect(result.stderr).toContain('codegraph:adapter:infra:test failed with exit code 29');
    expect(result.stderr).not.toContain('npm run codegraph:overlay:sync');
  });

  it.each(['full', 'quick'] as const)(
    'executes the real %s plan through direct Node and local Vitest transports',
    (profile) => {
      const harness = createHarness();
      const plan = readPlan(harness, profile);
      const args = profile === 'full' ? [] : ['--profile', 'quick'];
      const result = runGate(harness, args);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readInvocations(harness)).toEqual(expectedInvocations(plan));
      expect(existsSync(harness.poisonCanary)).toBe(false);
      expect(readdirSync(harness.logDir).filter(name => name.endsWith('.log'))).toEqual([]);
    },
    60_000,
  );

  it('rejects inherited legacy controls case-insensitively, including empty values', () => {
    for (const canonicalName of LEGACY_CONTROL_KEYS) {
      for (const [name, value] of [
        [canonicalName, ''],
        [mixedCase(canonicalName), 'sensitive-control-value'],
      ]) {
        const harness = createHarness();
        const controlValue = canonicalName === 'NANOFLOW_CODEGRAPH_GATE_NPM_CLI'
          && value !== '' ? harness.poisonCli : value;
        const result = runGate(harness, [], { [name]: controlValue });

        expect(result.status, `${name}=${JSON.stringify(value)}\n${result.stderr}`).toBe(1);
        expect(result.stderr).toContain(canonicalName);
        expect(result.stderr).not.toContain(controlValue || 'sensitive-control-value');
        expect(readInvocations(harness)).toEqual([]);
        expect(existsSync(harness.logDir)).toBe(false);
        expect(existsSync(harness.poisonCanary)).toBe(false);
      }
    }
  }, 60_000);

  it('rejects inherited controls before parsing arguments or creating side effects', () => {
    const harness = createHarness();
    const result = runGate(harness, ['--unknown'], {
      nanoflow_codegraph_gate_print_plan: '',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NANOFLOW_CODEGRAPH_GATE_PRINT_PLAN');
    expect(result.stderr).not.toContain('unknown argument');
    expect(readInvocations(harness)).toEqual([]);
    expect(existsSync(harness.logDir)).toBe(false);
  });

  it('fails closed for unknown profiles, unknown options, and missing option values', () => {
    const cases = [
      { args: ['--profile'], diagnostic: '--profile requires a value' },
      { args: ['--profile', 'invalid'], diagnostic: 'unknown gate profile: invalid' },
      { args: ['--unknown'], diagnostic: 'unknown argument: --unknown' },
    ];
    for (const testCase of cases) {
      const harness = createHarness();
      const result = runGate(harness, testCase.args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.diagnostic);
      expect(readInvocations(harness)).toEqual([]);
    }
  });

  it('stops at the first failing real-plan command and propagates its exact exit code', () => {
    const harness = createHarness();
    const result = runGate(harness, [], {
      STUB_FAIL_MATCH: 'codegraph-nanoflow-overlay-source-boundaries.spec.ts',
      STUB_EXIT_CODE: '17',
    });
    const invocations = readInvocations(harness);

    expect(result.status).toBe(17);
    expect(result.stderr).toContain('codegraph:overlay:test failed with exit code 17');
    expect(invocations.at(-1)?.args).toContain(
      'src/tests/scripts/codegraph-nanoflow-overlay-source-boundaries.spec.ts',
    );
    expect(invocations.some(call => call.script === 'scripts/smoke-codegraph-mcp-wrapper.cjs')).toBe(false);
  }, 60_000);

  it('retains captured failure logs and reports only bounded output tails', () => {
    const harness = createHarness();
    const result = runGate(harness, [], {
      NANOFLOW_CODEGRAPH_GATE_TAIL_CHARS: '600',
      STUB_NOISE_MATCH: 'minified bundles source maps and lockfiles',
      STUB_EXIT_CODE: '23',
    });

    expect(result.status).toBe(23);
    expect(result.stdout).not.toContain('stdout-line-0');
    expect(result.stderr).toContain('codegraph:adapter:context:packaged-artifacts failed with exit code 23');
    expect(result.stderr).toContain('stderr-line-199');
    expect(result.stderr).not.toContain('stderr-line-0\n');
    const logPath = result.stderr.match(/output log: (.+)/)?.[1]?.trim();
    expect(logPath).toEqual(expect.any(String));
    expect(readFileSync(logPath as string, 'utf8')).toContain('stdout-line-0');
  }, 60_000);

  it('applies the global timeout while preserving a real-plan per-step override', () => {
    const timedOutHarness = createHarness();
    const timedOut = runGate(timedOutHarness, [], {
      NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS: '250',
      STUB_DELAY_MATCH: 'scripts/codegraph-adapter-preflight.cjs',
      STUB_DELAY_MS: '10000',
    });
    expect(timedOut.status).toBe(1);
    expect(timedOut.stderr).toContain('codegraph:adapter:preflight timed out after 250ms');

    const overrideHarness = createHarness();
    const override = runGate(overrideHarness, [], {
      NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS: '250',
      STUB_DELAY_MATCH: 'codegraph-nanoflow-overlay-source-boundaries.spec.ts',
      STUB_DELAY_MS: '500',
    });
    expect(override.status, override.stderr).toBe(0);
    expect(override.stderr).not.toContain('timed out after 250ms');
  }, 60_000);

  it.skipIf(process.platform !== 'win32')(
    'kills a timed-out direct child before bounded identity-matched cleanup removes its detached wrapper descendant',
    () => {
      const harness = createHarness();
      const pwshShim = createBudgetExhaustingPwshShim(harness);
      const startedAt = Date.now();
      const result = runGate(harness, [], {
        NANOFLOW_CODEGRAPH_GATE_DISABLE_CLEANUP: '0',
        NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS: '250',
        NANOFLOW_CODEGRAPH_GATE_CLEANUP_TIMEOUT_MS: '3000',
        NANOFLOW_CODEGRAPH_GATE_PROCESS_SNAPSHOT_TIMEOUT_MS: '1000',
        STUB_DESCENDANT_MATCH: 'scripts/codegraph-adapter-preflight.cjs',
        STUB_HOLD_AFTER_DESCENDANT: '1',
        STUB_PWSH_COUNT_FILE: pwshShim.countFile,
      }, 15_000);
      const elapsedMs = Date.now() - startedAt;
      const directPid = Number(readFileSync(harness.directPid, 'utf8'));
      const descendantPid = Number(readFileSync(harness.descendantPid, 'utf8'));

      try {
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('codegraph:adapter:preflight timed out after 250ms');
        expect(elapsedMs).toBeLessThan(10_000);
        const shimCount = existsSync(pwshShim.countFile)
          ? Number(readFileSync(pwshShim.countFile, 'utf8').trim())
          : 0;
        expect(shimCount, result.stderr).toBeGreaterThanOrEqual(4);
        expect(waitForProcessExit(directPid), result.stderr).toBe(true);
        expect(waitForProcessExit(descendantPid), result.stderr).toBe(true);

        const source = readFileSync(runnerPath, 'utf8');
        const timeoutHandler = source.slice(
          source.indexOf('const timeoutTimer = setTimeout'),
          source.indexOf('child.on(\'error\'')
        );
        expect(timeoutHandler.indexOf("child.kill('SIGTERM')")).toBeLessThan(
          timeoutHandler.indexOf('cleanupGateDescendants('),
        );
        const cleanupBody = source.slice(
          source.indexOf('function cleanupGateDescendants'),
          source.indexOf('function findNewDescendantPids'),
        );
        expect(cleanupBody).not.toContain("process.kill(pid, 'SIGKILL')");
        expect(cleanupBody).not.toContain('Stop-Process -Id');
        expect(source).toContain('GetProcessTimes');
        expect(source).toContain('TerminateProcess');
        expect(source).toContain('NanoFlowIdentityTerminator');
      } finally {
        forceKill(directPid);
        forceKill(descendantPid);
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'fails closed when a discovered descendant PID now has a different creation identity',
    () => {
      const harness = createHarness();
      const pwshShim = createBudgetExhaustingPwshShim(harness);
      const result = runGate(harness, [], {
        NANOFLOW_CODEGRAPH_GATE_DISABLE_CLEANUP: '0',
        NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS: '250',
        NANOFLOW_CODEGRAPH_GATE_CLEANUP_TIMEOUT_MS: '3000',
        NANOFLOW_CODEGRAPH_GATE_PROCESS_SNAPSHOT_TIMEOUT_MS: '1000',
        STUB_DESCENDANT_MATCH: 'scripts/codegraph-adapter-preflight.cjs',
        STUB_HOLD_AFTER_DESCENDANT: '1',
        STUB_PWSH_COUNT_FILE: pwshShim.countFile,
        STUB_PWSH_IDENTITY_MODE: 'mismatch',
      }, 15_000);
      const directPid = Number(readFileSync(harness.directPid, 'utf8'));
      const successorPid = Number(readFileSync(harness.descendantPid, 'utf8'));

      try {
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('codegraph:adapter:preflight timed out after 250ms');
        expect(waitForProcessExit(directPid), result.stderr).toBe(true);
        expect(isProcessAlive(successorPid), result.stderr).toBe(true);
        expect(result.stderr).toMatch(/identity mismatch|stale target/i);
      } finally {
        forceKill(directPid);
        forceKill(successorPid);
        waitForProcessExit(directPid);
        waitForProcessExit(successorPid);
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'cleans up a wrapper-like detached descendant spawned by the real smoke command',
    () => {
      const harness = createHarness();
      const result = runGate(harness, [], {
        NANOFLOW_CODEGRAPH_GATE_DISABLE_CLEANUP: '0',
        STUB_DESCENDANT_MATCH: '\"--repeat\",\"5\"',
      }, 180_000);
      const descendantPid = Number(readFileSync(harness.descendantPid, 'utf8'));

      try {
        expect(result.status, result.stderr).toBe(0);
        expect(waitForProcessExit(descendantPid), result.stderr).toBe(true);
      } finally {
        forceKill(descendantPid);
      }
    },
    180_000,
  );

  it('contains no custom plan, npm transport, or legacy execution branch', () => {
    const source = readFileSync(runnerPath, 'utf8');
    for (const forbidden of [
      'LEGACY_NPM_GATE_STEPS',
      'loadGateSteps',
      'resolveNpmInvocation',
      'runStep',
      'npm_execpath',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toContain("command: process.platform === 'win32' ? 'npm.cmd' : 'npm'");
  });
});
