#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const GATE_MCP_WRAPPER_LOG_FILE = 'codegraph-adapter-gate-mcp-wrapper.log';
const GATE_STALE_MCP_WRAPPER_LOG_FILE = 'codegraph-adapter-gate-stale-mcp-wrapper.log';
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
  'src/tests/scripts/codegraph-adapter-preflight.spec.ts',
  'src/tests/scripts/codegraph-mcp-smoke.spec.ts',
  'src/tests/scripts/codegraph-overlay-baseline-manifest.spec.ts',
  'src/tests/scripts/validate-codegraph-overlay-docs.spec.ts',
  'src/tests/scripts/validate-codegraph-overlay-docs-structured-counts.spec.ts',
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
  'src/tests/scripts/codegraph-overlay-baseline-manifest.spec.ts',
  'src/tests/scripts/validate-codegraph-overlay-docs.spec.ts',
  'src/tests/scripts/validate-codegraph-overlay-docs-structured-counts.spec.ts',
];
const STRICT_DOCTOR_STEP = {
  name: 'codegraph:adapter:doctor:strict',
  command: 'node',
  args: ['scripts/codegraph-adapter-doctor.cjs', '--strict'],
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
  STRICT_DOCTOR_STEP,
  {
    name: 'codegraph:overlay:validate',
    commands: [
      { command: 'node', args: ['scripts/generate-codegraph-nanoflow-overlay.mjs'] },
      { command: 'node', args: ['scripts/validate-codegraph-overlay-docs.cjs'] },
    ],
  },
  {
    name: 'codegraph:adapter:infra:test',
    command: 'vitest',
    captureOutput: true,
    args: INFRA_TEST_ARGS,
  },
  ADAPTER_CONTEXT_CORE_STEP,
  ...ADAPTER_CONTEXT_LIVE_QUALITY_STEPS,
  {
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
  },
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

const QUICK_GATE_STEPS = [
  {
    name: 'codegraph:adapter:preflight',
    command: 'node',
    args: ['scripts/codegraph-adapter-preflight.cjs'],
  },
  STRICT_DOCTOR_STEP,
  {
    name: 'codegraph:adapter:infra:test',
    command: 'vitest',
    captureOutput: true,
    args: QUICK_INFRA_TEST_ARGS,
  },
  ADAPTER_CONTEXT_CORE_STEP,
  ...ADAPTER_CONTEXT_LIVE_QUALITY_STEPS,
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

const LEGACY_NPM_GATE_STEPS = [
  'codegraph:adapter:preflight',
  'codegraph:overlay:validate',
  'codegraph:adapter:infra:test',
  'codegraph:adapter:context',
  'codegraph:adapter:context:source-ordering',
  'codegraph:adapter:context:angular-route-redirect',
  'codegraph:adapter:context:host-binding',
  'codegraph:adapter:context:edge-function-route',
  'codegraph:adapter:context:dedup-boundary',
  'codegraph:overlay:test',
  'codegraph:mcp:smoke',
  'codegraph:mcp:stale-smoke',
  'codegraph:mcp:log:guard',
];
const CLEANUP_DISABLED = process.env.NANOFLOW_CODEGRAPH_GATE_DISABLE_CLEANUP === '1';
const DEFAULT_CAPTURE_TAIL_CHARS = 8_000;
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const GATE_PROCESS_PATTERNS = [
  /scripts[\\/]+generate-codegraph-nanoflow-overlay\.mjs/i,
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

function loadGateSteps() {
  const planFile = process.env.NANOFLOW_CODEGRAPH_GATE_PLAN_FILE;
  if (!planFile) {
    return gateStepsForProfile(parseArgs(process.argv.slice(2)).profile);
  }

  const parsed = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`Gate plan file must contain an array: ${planFile}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const parsed = {
    profile: process.env.NANOFLOW_CODEGRAPH_GATE_PROFILE || 'full',
    printPlan: process.env.NANOFLOW_CODEGRAPH_GATE_PRINT_PLAN === '1',
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
  const logDir = configured
    ? path.resolve(configured)
    : path.join(process.cwd(), 'tmp', 'codegraph-adapter-gate');
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function resolveGateLogPath(fileName) {
  return path.join(resolveGateLogDir(), fileName);
}

function safeLogFileName(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'step';
}

function createCommandLog(stepName) {
  const logDir = resolveGateLogDir();
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

function resolveNpmInvocation() {
  if (process.env.NANOFLOW_CODEGRAPH_GATE_NPM_CLI) {
    return {
      command: process.execPath,
      argsPrefix: [process.env.NANOFLOW_CODEGRAPH_GATE_NPM_CLI],
      shell: false,
    };
  }

  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      argsPrefix: [process.env.npm_execpath],
      shell: false,
    };
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    argsPrefix: [],
    shell: false,
  };
}

function runStep(scriptName) {
  const invocation = resolveNpmInvocation();
  const args = [...invocation.argsPrefix, 'run', scriptName];
  const timeoutMs = parsePositiveIntegerEnv('NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS', DEFAULT_STEP_TIMEOUT_MS);

  process.stderr.write(`[codegraph-adapter-gate] running ${scriptName}\n`);

  return new Promise((resolve) => {
    const processSnapshot = snapshotGateProcesses();
    let timedOut = false;
    let killGraceTimer = null;
    const child = spawn(invocation.command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: invocation.shell,
      stdio: 'inherit',
      windowsHide: true,
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(`[codegraph-adapter-gate] ${scriptName} timed out after ${timeoutMs}ms\n`);
      cleanupGateDescendants(processSnapshot, child.pid, scriptName);
      child.kill('SIGTERM');
      killGraceTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killGraceTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      cleanupGateDescendants(processSnapshot, child.pid, scriptName);
      process.stderr.write(
        `[codegraph-adapter-gate] ${scriptName} failed to start: ${error.message}\n`,
      );
      resolve(1);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      cleanupGateDescendants(processSnapshot, child.pid, scriptName);

      if (timedOut) {
        resolve(1);
        return;
      }

      if (signal) {
        process.stderr.write(
          `[codegraph-adapter-gate] ${scriptName} terminated by signal ${signal}\n`,
        );
        resolve(1);
        return;
      }

      if (code && code !== 0) {
        process.stderr.write(
          `[codegraph-adapter-gate] ${scriptName} failed with exit code ${code}\n`,
        );
      }

      resolve(code ?? 0);
    });
  });
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
    if (fs.existsSync(localVitest)) {
      return {
        command: process.execPath,
        args: [localVitest, ...commandSpec.args],
        shell: false,
      };
    }
  }

  return {
    command: commandSpec.command,
    args: commandSpec.args,
    shell: false,
  };
}

function runCommand(stepName, commandSpec) {
  const invocation = resolveCommand(commandSpec);
  const captureOutput = commandSpec.captureOutput === true;
  const logState = captureOutput ? createCommandLog(stepName) : null;
  const timeoutMs = parsePositiveIntegerEnv('NANOFLOW_CODEGRAPH_GATE_STEP_TIMEOUT_MS', DEFAULT_STEP_TIMEOUT_MS);

  return new Promise((resolve) => {
    const processSnapshot = snapshotGateProcesses();
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
      cleanupGateDescendants(processSnapshot, child.pid, stepName);
      child.kill('SIGTERM');
      killGraceTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killGraceTimer.unref?.();
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
      cleanupGateDescendants(processSnapshot, child.pid, stepName);
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

function snapshotGateProcesses() {
  if (CLEANUP_DISABLED || process.platform !== 'win32') {
    return new Map();
  }

  const result = spawnSyncPowerShell([
    '$ErrorActionPreference = "SilentlyContinue";',
    'Get-CimInstance Win32_Process -Filter "name = \'node.exe\'" |',
    'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
  ].join(' '));

  if (result.status !== 0 || !result.stdout.trim()) {
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
        commandLine: String(row.CommandLine ?? ''),
      }]));
  } catch {
    return new Map();
  }
}

function cleanupGateDescendants(beforeSnapshot, directChildPid, stepName) {
  if (CLEANUP_DISABLED || process.platform !== 'win32') {
    return;
  }

  const afterSnapshot = snapshotGateProcesses();
  if (afterSnapshot.size === 0) {
    return;
  }

  const cleanupPids = findGateDescendantPids(beforeSnapshot, afterSnapshot, directChildPid);
  if (cleanupPids.length === 0) {
    return;
  }

  process.stderr.write(
    `[codegraph-adapter-gate] cleaning ${cleanupPids.length} leftover process(es) after ${stepName}: ${cleanupPids.join(', ')}\n`,
  );

  for (const pid of cleanupPids) {
    spawnSyncPowerShell(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
  }
}

function findGateDescendantPids(beforeSnapshot, afterSnapshot, directChildPid) {
  const candidates = [];

  for (const processInfo of afterSnapshot.values()) {
    if (processInfo.pid === process.pid || processInfo.pid === directChildPid) {
      continue;
    }
    if (beforeSnapshot.has(processInfo.pid)) {
      continue;
    }
    if (!isGateProcess(processInfo.commandLine)) {
      continue;
    }
    candidates.push(processInfo);
  }

  const descendants = new Set();
  for (const candidate of candidates) {
    if (isDescendantOf(candidate.pid, directChildPid, afterSnapshot)) {
      descendants.add(candidate.pid);
    }
  }

  return [...descendants].sort((left, right) => right - left);
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

function spawnSyncPowerShell(command) {
  const powershellCommand = Array.isArray(command) ? command.join(' ') : command;
  return require('node:child_process').spawnSync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    powershellCommand,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
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
  const args = parseArgs(process.argv.slice(2));
  const gateSteps = loadGateSteps();

  if (args.printPlan) {
    process.stdout.write(`${JSON.stringify(gateSteps, null, 2)}\n`);
    return;
  }

  if (process.env.NANOFLOW_CODEGRAPH_GATE_NPM_CLI) {
    for (const step of LEGACY_NPM_GATE_STEPS) {
      const exitCode = await runStep(step);
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    }
    return;
  }

  for (const step of gateSteps) {
    const exitCode = await runGateStep(step);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[codegraph-adapter-gate] unexpected failure: ${error.message}\n`);
  process.exit(1);
});
