#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GATE_MCP_WRAPPER_LOG_FILE = 'codegraph-adapter-gate-mcp-wrapper.log';
const GATE_STALE_MCP_WRAPPER_LOG_FILE = 'codegraph-adapter-gate-stale-mcp-wrapper.log';
const LEGACY_CONTROL_ENV_KEYS = [
  'NANOFLOW_CODEGRAPH_GATE_PLAN_FILE',
  'NANOFLOW_CODEGRAPH_GATE_NPM_CLI',
  'NANOFLOW_CODEGRAPH_GATE_PROFILE',
  'NANOFLOW_CODEGRAPH_GATE_PRINT_PLAN',
];
const GATE_PROJECT_ROOT = process.cwd();
let privateGateLogDir = null;
const GATE_MCP_WRAPPER_LOG_PATH = resolveGateLogPath(GATE_MCP_WRAPPER_LOG_FILE);
const GATE_STALE_MCP_WRAPPER_LOG_PATH = resolveGateLogPath(GATE_STALE_MCP_WRAPPER_LOG_FILE);
const GATE_FAKE_CODEGRAPH_TARGET = path.join(process.cwd(), 'scripts', 'fake-codegraph-mcp.cjs');
const INFRA_TEST_ARGS = [
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
  'src/tests/scripts/codegraph-adapter-context-cli.spec.ts',
  'src/tests/scripts/codegraph-adapter-preflight.spec.ts',
  'src/tests/scripts/codegraph-mcp-smoke.spec.ts',
  'src/tests/scripts/codegraph-overlay-stability.spec.ts',
  'src/tests/scripts/codegraph-overlay-baseline-manifest.spec.ts',
];
const QUICK_INFRA_TEST_ARGS = [
  'run',
  '--config',
  'vitest.config.mts',
  '--no-file-parallelism',
  '--maxWorkers',
  '1',
  'src/tests/scripts/analyze-codegraph-mcp-log.spec.ts',
  'src/tests/scripts/agent-file-lease.spec.ts',
  'src/tests/scripts/codegraph-adapter-doctor.spec.ts',
  'src/tests/scripts/codegraph-adapter-preflight.spec.ts',
  'src/tests/scripts/codegraph-overlay-stability.spec.ts',
  'src/tests/scripts/codegraph-overlay-baseline-manifest.spec.ts',
];
const PRE_GENERATION_DOCTOR_STEP = {
  name: 'codegraph:adapter:doctor:pre-generation',
  command: 'node',
  args: ['scripts/codegraph-adapter-doctor.cjs', '--phase', 'pre-generation'],
};
const POST_GENERATION_STRICT_DOCTOR_STEP = {
  name: 'codegraph:adapter:doctor:post-generation:strict',
  command: 'node',
  args: ['scripts/codegraph-adapter-doctor.cjs', '--phase', 'post-generation', '--strict'],
};
const FINAL_STRICT_SEAL_STEP = {
  name: 'codegraph:adapter:doctor:final-seal',
  command: 'node',
  args: ['scripts/codegraph-adapter-doctor.cjs', '--phase', 'post-generation', '--strict'],
};
const TOOLING_DEPENDENCY_CLOSURE_STEP = {
  name: 'codegraph:tooling:dependency-closure',
  command: 'vitest',
  captureOutput: true,
  timeoutMs: 2 * 60 * 1000,
  args: [
    'run', '--config', 'vitest.config.mts', '--no-file-parallelism', '--maxWorkers', '1',
    'src/tests/contracts/tooling-security.contract.spec.ts',
    '--testNamePattern', 'tracked tooling runtime scripts must have a fully tracked local dependency closure',
  ],
};
const OVERLAY_DOCS_TEST_STEP = {
  name: 'codegraph:overlay:docs:test',
  command: 'vitest',
  captureOutput: true,
  args: [
    'run', '--config', 'vitest.config.mts', '--no-file-parallelism', '--maxWorkers', '1',
    'src/tests/scripts/validate-codegraph-overlay-docs.spec.ts',
    'src/tests/scripts/validate-codegraph-overlay-docs-structured-counts.spec.ts',
  ],
};
const ADAPTER_CONTEXT_CORE_STEP = {
  name: 'codegraph:adapter:context',
  command: 'node',
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
  captureOutput: true,
};
const ADAPTER_CONTEXT_DEDUP_BOUNDARY_QUERY = 'NanoFlow CodeGraph adaptation dedup contract source quality duplicated native behavior context pack source ordering adapter boundaries next gaps';
const ADAPTER_CONTEXT_LIVE_QUALITY_STEPS = [
  {
    name: 'codegraph:adapter:context:source-ordering',
    command: 'node',
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
    captureOutput: true,
  },
  {
    name: 'codegraph:adapter:context:angular-route-redirect',
    command: 'node',
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
    captureOutput: true,
  },
  {
    name: 'codegraph:adapter:context:host-binding',
    command: 'node',
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
    captureOutput: true,
  },
  {
    name: 'codegraph:adapter:context:edge-function-route',
    command: 'node',
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
    captureOutput: true,
  },
  {
    name: 'codegraph:adapter:context:dedup-boundary',
    command: 'node',
    args: [
      'scripts/codegraph-adapter-context.cjs',
      '--query',
      ADAPTER_CONTEXT_DEDUP_BOUNDARY_QUERY,
      '--overlay-query',
      ADAPTER_CONTEXT_DEDUP_BOUNDARY_QUERY,
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
    captureOutput: true,
  },
  {
    name: 'codegraph:adapter:context:packaged-artifacts',
    command: 'vitest',
    args: [
      'run',
      '--config',
      'vitest.config.mts',
      'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
      '--testNamePattern',
      'minified bundles source maps and lockfiles',
    ],
    captureOutput: true,
  },
];

const FULL_GATE_STEPS = [
  {
    name: 'codegraph:adapter:preflight',
    command: 'node',
    args: ['scripts/codegraph-adapter-preflight.cjs'],
  },
  PRE_GENERATION_DOCTOR_STEP,
  {
    name: 'codegraph:overlay:sync',
    commands: [
      { command: 'node', args: ['scripts/run-codegraph-overlay-stability.cjs'], timeoutMs: 20 * 60 * 1000 },
      { command: 'node', args: ['scripts/sync-codegraph-overlay-docs.cjs'], timeoutMs: 10 * 60 * 1000 },
    ],
  },
  {
    name: 'codegraph:overlay:validate',
    commands: [
      { command: 'node', args: ['scripts/sync-codegraph-overlay-docs.cjs', '--assert-clean'], timeoutMs: 30_000 },
      { command: 'node', args: ['scripts/validate-codegraph-overlay-docs.cjs'], timeoutMs: 10 * 60 * 1000 },
    ],
  },
  POST_GENERATION_STRICT_DOCTOR_STEP,
  {
    name: 'codegraph:adapter:infra:test',
    command: 'vitest',
    captureOutput: true,
    args: INFRA_TEST_ARGS,
  },
  TOOLING_DEPENDENCY_CLOSURE_STEP,
  ADAPTER_CONTEXT_CORE_STEP,
  ...ADAPTER_CONTEXT_LIVE_QUALITY_STEPS,
  {
    name: 'codegraph:overlay:test',
    command: 'vitest',
    captureOutput: true,
    timeoutMs: 15 * 60 * 1000,
    args: [
      'run',
      '--config',
      'vitest.config.mts',
      'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
      'src/tests/scripts/codegraph-nanoflow-overlay-source-boundaries.spec.ts',
    ],
  },
  OVERLAY_DOCS_TEST_STEP,
  {
    name: 'codegraph:mcp:smoke',
    command: 'node',
    args: [
      'scripts/smoke-codegraph-mcp-wrapper.cjs',
      '--query',
      'scripts/codegraph-adapter-context.cjs parseArgs',
      '--overlay-query',
      'sync-required-field',
      '--repeat',
      '5',
      '--overlay-limit',
      '60',
      '--overlay-query-limit',
      '60',
      '--timeout-ms',
      '90000',
    ],
    env: {
      NANOFLOW_CODEGRAPH_MCP_LOG: GATE_MCP_WRAPPER_LOG_PATH,
    },
  },
  {
    name: 'codegraph:mcp:stale-smoke',
    command: 'node',
    args: [
      'scripts/smoke-codegraph-mcp-wrapper.cjs',
      '--codegraph-target',
      GATE_FAKE_CODEGRAPH_TARGET,
      '--query',
      'scripts/codegraph-adapter-context.cjs parseArgs',
      '--overlay-query',
      'sync-required-field',
      '--repeat',
      '1',
      '--overlay-limit',
      '1',
      '--overlay-query-limit',
      '1',
      '--simulate-stale-wrapper-script',
      '--timeout-ms',
      '90000',
    ],
    env: {
      NANOFLOW_CODEGRAPH_MCP_LOG: GATE_STALE_MCP_WRAPPER_LOG_PATH,
    },
  },
  {
    name: 'codegraph:mcp:log:guard',
    command: 'node',
    args: [
      'scripts/analyze-codegraph-mcp-log.cjs',
      GATE_MCP_WRAPPER_LOG_PATH,
      '--project-root',
      GATE_PROJECT_ROOT,
      '--json',
      '--observed-at',
      'now',
      '--fail-on-critical',
      '--fail-on-current-source-ordering',
      '--fail-on-current-autosync-disabled',
      '--fail-on-stale-current-wrapper',
      '--fail-on-active-stale-wrappers',
      '--fail-on-host-config-mismatch',
      '--fail-on-untrusted-direct-mcp',
    ],
  },
  FINAL_STRICT_SEAL_STEP,
];

const QUICK_GATE_STEPS = [
  {
    name: 'codegraph:adapter:preflight',
    command: 'node',
    args: ['scripts/codegraph-adapter-preflight.cjs'],
  },
  POST_GENERATION_STRICT_DOCTOR_STEP,
  {
    name: 'codegraph:overlay:validate',
    command: 'node',
    args: ['scripts/validate-codegraph-overlay-docs.cjs'],
    timeoutMs: 10 * 60 * 1000,
  },
  {
    name: 'codegraph:adapter:infra:test',
    command: 'vitest',
    captureOutput: true,
    args: QUICK_INFRA_TEST_ARGS,
  },
  TOOLING_DEPENDENCY_CLOSURE_STEP,
  ADAPTER_CONTEXT_CORE_STEP,
  ...ADAPTER_CONTEXT_LIVE_QUALITY_STEPS,
  OVERLAY_DOCS_TEST_STEP,
  {
    name: 'codegraph:mcp:smoke',
    command: 'node',
    args: [
      'scripts/smoke-codegraph-mcp-wrapper.cjs',
      '--query',
      'scripts/codegraph-adapter-context.cjs parseArgs',
      '--overlay-query',
      'sync-required-field',
      '--repeat',
      '1',
      '--overlay-limit',
      '30',
      '--overlay-query-limit',
      '30',
      '--timeout-ms',
      '90000',
    ],
    env: {
      NANOFLOW_CODEGRAPH_MCP_LOG: GATE_MCP_WRAPPER_LOG_PATH,
    },
  },
  {
    name: 'codegraph:mcp:stale-smoke',
    command: 'node',
    args: [
      'scripts/smoke-codegraph-mcp-wrapper.cjs',
      '--codegraph-target',
      GATE_FAKE_CODEGRAPH_TARGET,
      '--query',
      'scripts/codegraph-adapter-context.cjs parseArgs',
      '--overlay-query',
      'sync-required-field',
      '--repeat',
      '1',
      '--overlay-limit',
      '1',
      '--overlay-query-limit',
      '1',
      '--simulate-stale-wrapper-script',
      '--timeout-ms',
      '90000',
    ],
    env: {
      NANOFLOW_CODEGRAPH_MCP_LOG: GATE_STALE_MCP_WRAPPER_LOG_PATH,
    },
  },
  {
    name: 'codegraph:mcp:log:guard',
    command: 'node',
    args: [
      'scripts/analyze-codegraph-mcp-log.cjs',
      GATE_MCP_WRAPPER_LOG_PATH,
      '--project-root',
      GATE_PROJECT_ROOT,
      '--json',
      '--observed-at',
      'now',
      '--fail-on-critical',
      '--fail-on-current-source-ordering',
      '--fail-on-current-autosync-disabled',
      '--fail-on-stale-current-wrapper',
      '--fail-on-active-stale-wrappers',
      '--fail-on-host-config-mismatch',
      '--fail-on-untrusted-direct-mcp',
    ],
  },
];

const CLEANUP_DISABLED = process.env.NANOFLOW_CODEGRAPH_GATE_DISABLE_CLEANUP === '1';
const DEFAULT_CAPTURE_TAIL_CHARS = 8_000;
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS = 5_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_DESCENDANT_TERMINATION_RESERVE_MS = 1_500;
let processSnapshotWarningWritten = false;
const WINDOWS_NODE_PROCESS_SNAPSHOT_COMMAND = String.raw`
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NanoFlowProcessSnapshot {
  const uint SnapshotProcesses = 2;
  const uint QueryLimitedInformation = 0x1000;
  static readonly IntPtr InvalidHandle = new IntPtr(-1);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry { public uint size, usage, processId; public IntPtr heap; public uint moduleId, threads, parentProcessId; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executable; }
  [StructLayout(LayoutKind.Sequential)]
  struct FileTime { public uint low, high; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  static string CreationIdentity(uint processId) {
    var process = OpenProcess(QueryLimitedInformation, false, processId);
    if (process == IntPtr.Zero) return null;
    try { FileTime creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return null;
      return (((ulong)creation.high << 32) | creation.low).ToString();
    } finally { CloseHandle(process); }
  }
  public static string NodeProcessesJson() {
    var rows = new List<string>(); var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
    if (snapshot == InvalidHandle) throw new InvalidOperationException("CreateToolhelp32Snapshot failed: " + Marshal.GetLastWin32Error());
    try { var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
      if (!Process32FirstW(snapshot, ref entry)) return "[]";
      do { if (string.Equals(entry.executable, "node.exe", StringComparison.OrdinalIgnoreCase)) { var identity = CreationIdentity(entry.processId); rows.Add("{\"ProcessId\":" + entry.processId + ",\"ParentProcessId\":" + entry.parentProcessId + ",\"CreationFileTime\":" + (identity == null ? "null" : "\"" + identity + "\"") + "}"); } entry.size = (uint)Marshal.SizeOf(typeof(Entry)); } while (Process32NextW(snapshot, ref entry));
      return "[" + string.Join(",", rows) + "]";
    } finally { CloseHandle(snapshot); }
  }
}
'@
Add-Type -TypeDefinition $source
[NanoFlowProcessSnapshot]::NodeProcessesJson()
`;
const WINDOWS_IDENTITY_TERMINATOR_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NanoFlowIdentityTerminator {
  const uint Terminate = 0x0001;
  const uint QueryLimitedInformation = 0x1000;
  const uint Synchronize = 0x00100000;
  const uint WaitObject0 = 0x00000000;
  const uint WaitTimeout = 0x00000102;
  const int ErrorInvalidParameter = 87;
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low, high; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  static string Row(uint pid, ulong expected, ulong? observed, string status, int errorCode) {
    return "{\"pid\":" + pid + ",\"expectedIdentity\":\"" + expected + "\",\"observedIdentity\":"
      + (observed.HasValue ? "\"" + observed.Value + "\"" : "null")
      + ",\"status\":\"" + status + "\",\"errorCode\":" + errorCode + "}";
  }
  public static string TerminateExpected(string encodedTargets, uint waitMilliseconds) {
    var rows = new List<string>();
    var payload = Encoding.UTF8.GetString(Convert.FromBase64String(encodedTargets));
    foreach (var token in payload.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries)) {
      var pair = token.Split(':'); var pid = UInt32.Parse(pair[0]); var expected = UInt64.Parse(pair[1]);
      var process = OpenProcess(Terminate | QueryLimitedInformation | Synchronize, false, pid);
      if (process == IntPtr.Zero) { var error = Marshal.GetLastWin32Error(); rows.Add(Row(pid, expected, null, error == ErrorInvalidParameter ? "not-found" : "identity-unavailable", error)); continue; }
      try {
        FileTime creation, exit, kernel, user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) { rows.Add(Row(pid, expected, null, "identity-unavailable", Marshal.GetLastWin32Error())); continue; }
        var observed = ((ulong)creation.high << 32) | creation.low;
        if (observed != expected) { rows.Add(Row(pid, expected, observed, "identity-mismatch", 0)); continue; }
        if (WaitForSingleObject(process, 0) == WaitObject0) { rows.Add(Row(pid, expected, observed, "already-exited", 0)); continue; }
        if (!TerminateProcess(process, 1)) { rows.Add(Row(pid, expected, observed, "terminate-failed", Marshal.GetLastWin32Error())); continue; }
        var wait = WaitForSingleObject(process, waitMilliseconds);
        rows.Add(Row(pid, expected, observed, wait == WaitObject0 ? "terminated" : (wait == WaitTimeout ? "termination-pending" : "confirmation-failed"), wait == WaitObject0 || wait == WaitTimeout ? 0 : Marshal.GetLastWin32Error()));
      } finally { CloseHandle(process); }
    }
    return "[" + string.Join(",", rows) + "]";
  }
}
`;
const GATE_PROCESS_PATTERNS = [
  /scripts[\\/]+generate-codegraph-nanoflow-overlay\.mjs/i,
  /scripts[\\/]+run-codegraph-overlay-stability\.cjs/i,
  /scripts[\\/]+sync-codegraph-overlay-docs\.cjs/i,
  /scripts[\\/]+validate-codegraph-overlay-docs\.cjs/i,
  /scripts[\\/]+smoke-codegraph-mcp-wrapper\.cjs/i,
  /scripts[\\/]+analyze-codegraph-mcp-log\.cjs/i,
  /scripts[\\/]+run-codegraph-adapter-gate\.cjs/i,
  /scripts[\\/]+codegraph-nanoflow-mcp-stdio\.cjs/i,
  /codegraph\.js\s+serve\s+--mcp/i,
  /codegraph-nanoflow-overlay\.spec\.ts/i,
  /vitest(?:\.mjs)?/i,
];
function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function rejectLegacyControlEnvironment(env) {
  const presentKeys = new Set(Object.keys(env).map(key => key.toUpperCase()));
  for (const canonicalName of LEGACY_CONTROL_ENV_KEYS) {
    if (presentKeys.has(canonicalName)) {
      throw new Error(`legacy environment control is not supported: ${canonicalName}`);
    }
  }
}
function parseArgs(argv) {
  const parsed = {
    profile: 'full',
    printPlan: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--print-plan') {
      parsed.printPlan = true;
      continue;
    }
    if (arg === '--profile') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--profile requires a value');
      }
      parsed.profile = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}
function gateStepsForProfile(profile) {
  if (profile === 'full') return FULL_GATE_STEPS;
  if (profile === 'quick') return QUICK_GATE_STEPS;
  throw new Error(`unknown gate profile: ${profile}`);
}
function resolveGateLogDir() {
  const configured = process.env.NANOFLOW_CODEGRAPH_GATE_LOG_DIR;
  if (configured) return path.resolve(configured);
  if (privateGateLogDir) return privateGateLogDir;

  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-gate-'));
  try {
    fs.chmodSync(created, 0o700);
  } catch (error) {
    if (process.platform !== 'win32') {
      fs.rmSync(created, { recursive: true, force: true });
      throw error;
    }
  }
  privateGateLogDir = created;
  return privateGateLogDir;
}

function resolveGateLogPath(fileName) {
  return path.join(resolveGateLogDir(), fileName);
}

function safeLogFileName(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'step';
}

function createCommandLog(stepName) {
  const logDir = resolveGateLogDir();
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(
    logDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeLogFileName(stepName)}.log`,
  );
  return {
    logPath,
    stream: fs.createWriteStream(logPath, { flags: 'w' }),
    tail: '',
    tails: {
      stdout: '',
      stderr: '',
    },
    tailLimit: parsePositiveIntegerEnv('NANOFLOW_CODEGRAPH_GATE_TAIL_CHARS', DEFAULT_CAPTURE_TAIL_CHARS),
  };
}

function appendCommandOutput(logState, chunk, streamName = 'output') {
  if (!logState) return;
  const text = chunk.toString('utf8');
  logState.stream.write(text);
  logState.tail += text;
  if (logState.tail.length > logState.tailLimit) {
    logState.tail = logState.tail.slice(-logState.tailLimit);
  }
  if (streamName === 'stdout' || streamName === 'stderr') {
    logState.tails[streamName] += text;
    const perStreamLimit = Math.max(1, Math.floor(logState.tailLimit / 2));
    if (logState.tails[streamName].length > perStreamLimit) {
      logState.tails[streamName] = trimTailToLineBoundary(
        logState.tails[streamName].slice(-perStreamLimit),
      );
    }
  }
}

function closeCommandLog(logState, callback) {
  if (!logState) {
    callback();
    return;
  }
  logState.stream.end(callback);
}

function writeCapturedFailure(stepName, code, signal, logState) {
  const reason = signal ? `signal ${signal}` : `exit code ${code}`;
  process.stderr.write(`[codegraph-adapter-gate] ${stepName} failed with ${reason}\n`);
  if (!logState) return;
  process.stderr.write(`[codegraph-adapter-gate] output log: ${logState.logPath}\n`);
  writeCapturedTail(logState);
}

function writeCapturedTimeout(stepName, timeoutMs, logState) {
  process.stderr.write(`[codegraph-adapter-gate] ${stepName} timed out after ${timeoutMs}ms\n`);
  if (!logState) return;
  process.stderr.write(`[codegraph-adapter-gate] output log: ${logState.logPath}\n`);
  writeCapturedTail(logState);
}

function writeCapturedTail(logState) {
  const stderrTail = logState.tails.stderr.trimEnd();
  const stdoutTail = logState.tails.stdout.trimEnd();
  if (stderrTail) {
    process.stderr.write(`[codegraph-adapter-gate] last ${Math.floor(logState.tailLimit / 2)} stderr chars:\n${stderrTail}\n`);
  }
  if (stdoutTail) {
    process.stderr.write(`[codegraph-adapter-gate] last ${Math.floor(logState.tailLimit / 2)} stdout chars:\n${stdoutTail}\n`);
  }
  if (!stderrTail && !stdoutTail) {
    const tail = logState.tail.trimEnd();
    if (tail) {
      process.stderr.write(`[codegraph-adapter-gate] last ${logState.tailLimit} output chars:\n${tail}\n`);
    }
  }
}

function trimTailToLineBoundary(value) {
  const normalized = String(value ?? '');
  const firstNewline = normalized.search(/\r?\n/);
  if (firstNewline <= 0) {
    return normalized;
  }
  return normalized.slice(firstNewline + (normalized[firstNewline] === '\r' && normalized[firstNewline + 1] === '\n' ? 2 : 1));
}

function removeSuccessfulCommandLog(stepName, logState) {
  if (!logState) return;
  try {
    fs.rmSync(logState.logPath, { force: true });
  } catch (error) {
    process.stderr.write(
      `[codegraph-adapter-gate] warning: could not remove successful ${stepName} log ${logState.logPath}: ${error.message}\n`,
    );
  }
}

function resolveCommand(commandSpec) {
  if (commandSpec.command === 'node') {
    return {
      command: process.execPath,
      args: commandSpec.args,
      shell: false,
    };
  }

  if (commandSpec.command === 'vitest') {
    const localVitest = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
    return {
      command: process.execPath,
      args: [localVitest, ...commandSpec.args],
      shell: false,
    };
  }

  throw new Error(`unsupported gate command: ${commandSpec.command}`);
}

function runCommand(stepName, commandSpec) {
  const invocation = resolveCommand(commandSpec);
  const captureOutput = commandSpec.captureOutput === true;
  const logState = captureOutput ? createCommandLog(stepName) : null;
  const defaultTimeoutMs = parsePositiveIntegerEnv(
    'NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS',
    DEFAULT_STEP_TIMEOUT_MS,
  );
  const requestedTimeoutMs = Number(commandSpec.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.floor(requestedTimeoutMs)
    : defaultTimeoutMs;
  const cleanupTimeoutMs = parsePositiveIntegerEnv(
    'NANOFLOW_CODEGRAPH_GATE_CLEANUP_TIMEOUT_MS',
    DEFAULT_CLEANUP_TIMEOUT_MS,
  );

  return new Promise((resolve) => {
    const processSnapshot = snapshotGateProcesses(Date.now() + cleanupTimeoutMs);
    let timedOut = false;
    let killGraceTimer = null;
    const child = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(commandSpec.env ?? {}),
      },
      shell: invocation.shell,
      stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });

    if (captureOutput) {
      child.stdout?.on('data', chunk => appendCommandOutput(logState, chunk, 'stdout'));
      child.stderr?.on('data', chunk => appendCommandOutput(logState, chunk, 'stderr'));
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killGraceTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killGraceTimer.unref?.();
      cleanupGateDescendants(
        processSnapshot,
        child.pid,
        stepName,
        Date.now() + cleanupTimeoutMs,
      );
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      process.stderr.write(
        `[codegraph-adapter-gate] ${stepName} failed to start: ${error.message}\n`,
      );
      closeCommandLog(logState, () => resolve(1));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      if (!timedOut) {
        cleanupGateDescendants(
          processSnapshot,
          child.pid,
          stepName,
          Date.now() + cleanupTimeoutMs,
        );
      }
      closeCommandLog(logState, () => {
        if (timedOut) {
          writeCapturedTimeout(stepName, timeoutMs, logState);
          resolve(1);
          return;
        }

        if (signal) {
          if (captureOutput) {
            writeCapturedFailure(stepName, code ?? 1, signal, logState);
          } else {
            process.stderr.write(
              `[codegraph-adapter-gate] ${stepName} terminated by signal ${signal}\n`,
            );
          }
          resolve(1);
          return;
        }

        if (code && code !== 0) {
          if (captureOutput) {
            writeCapturedFailure(stepName, code, null, logState);
          } else {
            process.stderr.write(
              `[codegraph-adapter-gate] ${stepName} failed with exit code ${code}\n`,
            );
          }
        }

        if (!code) {
          removeSuccessfulCommandLog(stepName, logState);
        }

        resolve(code ?? 0);
      });
    });
  });
}

function remainingDeadlineMs(deadline, maximumMs) {
  const remainingMs = Math.floor(deadline - Date.now());
  if (remainingMs <= 0) return 0;
  return Math.max(1, Math.min(maximumMs, remainingMs));
}

function snapshotGateProcesses(deadline) {
  if (CLEANUP_DISABLED || process.platform !== 'win32') {
    return new Map();
  }

  const configuredTimeoutMs = parsePositiveIntegerEnv(
    'NANOFLOW_CODEGRAPH_GATE_PROCESS_SNAPSHOT_TIMEOUT_MS',
    DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS,
  );
  const timeoutMs = remainingDeadlineMs(deadline, configuredTimeoutMs);
  if (timeoutMs === 0) return new Map();
  let snapshot = runProcessSnapshotCommand(timeoutMs, deadline);
  let { result } = snapshot;

  if (result.status !== 0 || result.error) {
    const initialFailure = describeSnapshotFailure(result);
    const retryTimeoutMs = remainingDeadlineMs(
      deadline,
      Math.max(configuredTimeoutMs, DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS),
    );
    if (retryTimeoutMs === 0) {
      writeProcessSnapshotWarning(snapshot.backend, initialFailure, timeoutMs);
      return new Map();
    }
    const retrySnapshot = runProcessSnapshotCommand(retryTimeoutMs, deadline);
    const retryFailure = retrySnapshot.result.status !== 0 || retrySnapshot.result.error
      ? describeSnapshotFailure(retrySnapshot.result)
      : null;
    writeProcessSnapshotWarning(
      snapshot.backend,
      initialFailure,
      timeoutMs,
      retryFailure ? `cleanup skipped retryBackend=${retrySnapshot.backend} retryReason=${retryFailure}` : `recovered by bounded retry retryBackend=${retrySnapshot.backend}`,
      retryTimeoutMs,
    );
    if (retryFailure) return new Map();
    snapshot = retrySnapshot;
    result = retrySnapshot.result;
  }
  if (!result.stdout.trim()) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return new Map(rows
      .filter(row => row?.ProcessId)
      .map(row => [Number(row.ProcessId), {
        pid: Number(row.ProcessId),
        parentPid: Number(row.ParentProcessId ?? 0),
        creationIdentity: normalizeProcessCreationIdentity(row.CreationFileTime),
        commandLine: String(row.CommandLine ?? ''),
      }]));
  } catch (error) {
    writeProcessSnapshotWarning(snapshot.backend, `invalid-json:${error.message}`, timeoutMs);
    return new Map();
  }
}

function runProcessSnapshotCommand(timeoutMs, deadline) {
  const pwshResult = spawnSyncPowerShell(WINDOWS_NODE_PROCESS_SNAPSHOT_COMMAND, {
    executable: 'pwsh',
    timeoutMs,
  });

  if (pwshResult.status === 0 || pwshResult.error?.code === 'ETIMEDOUT') {
    return { backend: 'pwsh:Toolhelp32', result: pwshResult };
  }

  const fallbackTimeoutMs = remainingDeadlineMs(deadline, timeoutMs);
  if (fallbackTimeoutMs === 0) {
    return { backend: 'pwsh:Toolhelp32', result: pwshResult };
  }

  return {
    backend: 'powershell:Toolhelp32',
    result: spawnSyncPowerShell(WINDOWS_NODE_PROCESS_SNAPSHOT_COMMAND, {
      executable: 'powershell',
      timeoutMs: fallbackTimeoutMs,
    }),
  };
}

function normalizeProcessCreationIdentity(value) {
  const identity = String(value ?? '').trim();
  return /^\d+$/.test(identity) ? identity : null;
}

function describeSnapshotFailure(result) {
  if (result.error?.code === 'ETIMEDOUT') return 'timeout';
  if (result.error?.code) return `spawn-${result.error.code}`;
  if (result.signal) return `signal-${result.signal}`;
  return `exit-${result.status ?? 'unknown'}`;
}

function writeProcessSnapshotWarning(backend, reason, timeoutMs, outcome = 'cleanup skipped', retryTimeoutMs = null) {
  if (processSnapshotWarningWritten) return;
  processSnapshotWarningWritten = true;
  process.stderr.write(
    `[codegraph-adapter-gate] process snapshot unavailable; ${outcome} `
      + `backend=${backend} reason=${reason} timeoutMs=${timeoutMs}`
      + `${retryTimeoutMs ? ` retryTimeoutMs=${retryTimeoutMs}` : ''}\n`,
  );
}

function cleanupGateDescendants(beforeSnapshot, directChildPid, stepName, deadline) {
  if (CLEANUP_DISABLED || process.platform !== 'win32') {
    return;
  }

  const cleanupStartedAt = Date.now();
  const totalRemainingMs = Math.max(0, deadline - cleanupStartedAt);
  const terminationReserveMs = Math.min(
    DEFAULT_DESCENDANT_TERMINATION_RESERVE_MS,
    totalRemainingMs,
  );
  const discoveryDeadline = deadline - terminationReserveMs;
  const afterSnapshot = snapshotGateProcesses(discoveryDeadline);
  if (afterSnapshot.size === 0) {
    return;
  }

  const descendantTargets = findNewDescendantPids(beforeSnapshot, afterSnapshot, directChildPid);
  const commandLines = readGateProcessCommandLines(descendantTargets, discoveryDeadline);
  const cleanupTargets = descendantTargets.filter((target) => {
    const commandLine = commandLines.get(target.pid);
    return !commandLine || isGateProcess(commandLine);
  });
  if (cleanupTargets.length === 0) {
    return;
  }

  const identityBoundTargets = [];
  for (const target of cleanupTargets) {
    if (!target.creationIdentity) {
      process.stderr.write(
        `[codegraph-adapter-gate] warning: stale target pid=${target.pid} after ${stepName}; `
          + 'creation identity unavailable, cleanup failed closed\n',
      );
      continue;
    }
    identityBoundTargets.push(target);
  }
  if (identityBoundTargets.length === 0) {
    return;
  }

  process.stderr.write(
    `[codegraph-adapter-gate] cleaning ${identityBoundTargets.length} identity-bound leftover process(es) `
      + `after ${stepName}: ${identityBoundTargets.map(target => target.pid).join(', ')}\n`,
  );

  const termination = terminateIdentityMatchedTargets(identityBoundTargets, deadline);
  if (termination.failure) {
    process.stderr.write(
      `[codegraph-adapter-gate] warning: identity-bound descendant cleanup unavailable after ${stepName}; `
        + `${termination.failure}\n`,
    );
    return;
  }

  for (const target of identityBoundTargets) {
    const result = termination.results.get(target.pid);
    if (!result) {
      process.stderr.write(
        `[codegraph-adapter-gate] warning: descendant cleanup incomplete after ${stepName}; `
          + `pid=${target.pid} status=missing-result\n`,
      );
      continue;
    }
    if (result.status === 'terminated' || result.status === 'already-exited' || result.status === 'not-found') {
      continue;
    }
    if (result.status === 'identity-mismatch') {
      process.stderr.write(
        `[codegraph-adapter-gate] warning: stale target pid=${target.pid} after ${stepName}; identity mismatch `
          + `expected=${target.creationIdentity} observed=${result.observedIdentity ?? 'unavailable'}, cleanup failed closed\n`,
      );
      continue;
    }
    process.stderr.write(
      `[codegraph-adapter-gate] warning: descendant cleanup incomplete after ${stepName}; pid=${target.pid} `
        + `status=${result.status ?? 'unknown'} errorCode=${result.errorCode ?? 'unknown'}\n`,
    );
  }
}

function findNewDescendantPids(beforeSnapshot, afterSnapshot, directChildPid) {
  const candidates = [];

  for (const processInfo of afterSnapshot.values()) {
    if (processInfo.pid === process.pid || processInfo.pid === directChildPid) {
      continue;
    }
    const beforeProcess = beforeSnapshot.get(processInfo.pid);
    if (beforeProcess) {
      if (!beforeProcess.creationIdentity || !processInfo.creationIdentity) {
        process.stderr.write(
          `[codegraph-adapter-gate] warning: stale target pid=${processInfo.pid}; baseline/current creation identity `
            + 'unavailable, cleanup failed closed\n',
        );
        continue;
      }
      if (beforeProcess.creationIdentity === processInfo.creationIdentity) {
        continue;
      }
    }
    candidates.push(processInfo);
  }

  const descendants = new Map();
  for (const candidate of candidates) {
    if (isDescendantOf(candidate.pid, directChildPid, afterSnapshot)) {
      descendants.set(candidate.pid, candidate);
    }
  }

  return [...descendants.values()].sort((left, right) => right.pid - left.pid);
}

function readGateProcessCommandLines(targets, deadline) {
  if (targets.length === 0) return new Map();

  const configuredTimeoutMs = parsePositiveIntegerEnv(
    'NANOFLOW_CODEGRAPH_GATE_PROCESS_SNAPSHOT_TIMEOUT_MS',
    DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS,
  );
  const timeoutMs = remainingDeadlineMs(deadline, configuredTimeoutMs);
  if (timeoutMs === 0) return new Map();
  const pidList = targets.map(target => Number(target.pid)).filter(Number.isSafeInteger).join(',');
  const result = spawnSyncPowerShell([
    '$ErrorActionPreference = "Stop";',
    `Get-Process -Id ${pidList} -ErrorAction SilentlyContinue |`,
    'Select-Object @{Name="ProcessId";Expression={$_.Id}},CommandLine |',
    'ConvertTo-Json -Compress',
  ].join(' '), { executable: 'pwsh', timeoutMs });

  if (result.status !== 0 || result.error) {
    writeProcessSnapshotWarning('pwsh:Get-Process-command-line', describeSnapshotFailure(result), timeoutMs);
    return new Map();
  }
  if (!result.stdout.trim()) return new Map();

  try {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return new Map(rows
      .filter(row => row?.ProcessId)
      .map(row => [Number(row.ProcessId), String(row.CommandLine ?? '')]));
  } catch (error) {
    writeProcessSnapshotWarning(
      'pwsh:Get-Process-command-line',
      `invalid-json:${error.message}`,
      timeoutMs,
    );
    return new Map();
  }
}

function terminateIdentityMatchedTargets(targets, deadline) {
  const timeoutMs = remainingDeadlineMs(deadline, DEFAULT_CLEANUP_TIMEOUT_MS);
  if (timeoutMs === 0) {
    return { results: new Map(), failure: 'deadline exhausted before identity verification' };
  }

  const encodedSource = Buffer.from(WINDOWS_IDENTITY_TERMINATOR_SOURCE, 'utf8').toString('base64');
  const encodedTargets = Buffer.from(
    targets.map(target => `${target.pid}:${target.creationIdentity}`).join(','),
    'utf8',
  ).toString('base64');
  const waitMilliseconds = Math.max(1, Math.floor(timeoutMs / Math.max(1, targets.length)));
  const result = spawnSyncPowerShell([
    '$ErrorActionPreference = "Stop";',
    `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedSource}'));`,
    'Add-Type -TypeDefinition $source;',
    `[NanoFlowIdentityTerminator]::TerminateExpected('${encodedTargets}', ${waitMilliseconds})`,
  ], { executable: 'powershell', timeoutMs });

  if (result.status !== 0 || result.error) {
    return {
      results: new Map(),
      failure: `backend=powershell:NanoFlowIdentityTerminator reason=${describeSnapshotFailure(result)} timeoutMs=${timeoutMs}`,
    };
  }
  if (!result.stdout.trim()) {
    return { results: new Map(), failure: 'backend=powershell:NanoFlowIdentityTerminator reason=empty-output' };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return {
      results: new Map(rows
        .filter(row => Number.isSafeInteger(Number(row?.pid)))
        .map(row => [Number(row.pid), row])),
      failure: null,
    };
  } catch (error) {
    return {
      results: new Map(),
      failure: `backend=powershell:NanoFlowIdentityTerminator reason=invalid-json:${error.message}`,
    };
  }
}

function isDescendantOf(pid, ancestorPid, processMap) {
  let current = processMap.get(pid);
  const seen = new Set();

  while (current && current.parentPid && !seen.has(current.pid)) {
    if (current.parentPid === ancestorPid) {
      return true;
    }
    seen.add(current.pid);
    current = processMap.get(current.parentPid);
  }

  return false;
}

function isGateProcess(commandLine) {
  return GATE_PROCESS_PATTERNS.some(pattern => pattern.test(commandLine));
}

function spawnSyncPowerShell(command, options = {}) {
  const powershellCommand = Array.isArray(command) ? command.join(' ') : command;
  return spawnSync(options.executable ?? 'powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    powershellCommand,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs,
  });
}

async function runGateStep(step) {
  process.stderr.write(`[codegraph-adapter-gate] running ${step.name}\n`);

  const commands = step.commands ?? [step];
  for (const commandSpec of commands) {
    const exitCode = await runCommand(step.name, commandSpec);
    if (exitCode !== 0) {
      return exitCode;
    }
  }

  return 0;
}

async function main() {
  rejectLegacyControlEnvironment(process.env);
  const args = parseArgs(process.argv.slice(2));
  const gateSteps = gateStepsForProfile(args.profile);

  if (args.printPlan) {
    process.stdout.write(`${JSON.stringify(gateSteps, null, 2)}\n`);
    return;
  }

  for (const step of gateSteps) {
    const exitCode = await runGateStep(step);
    if (exitCode !== 0) {
      if (
        args.profile === 'quick'
        && (
          step.name === 'codegraph:adapter:doctor:post-generation:strict'
          || step.name === 'codegraph:overlay:validate'
        )
      ) {
        process.stderr.write(
          '[codegraph-adapter-gate] quick profile is read-only; refresh with npm run codegraph:overlay:sync\n',
        );
      }
      process.exit(exitCode);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[codegraph-adapter-gate] unexpected failure: ${error.message}\n`);
  process.exit(1);
});
