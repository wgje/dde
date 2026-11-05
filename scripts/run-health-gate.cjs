#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_TAIL_CHARS = 6_000;
const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000;
const PROCESS_TREE_CLEANUP_TIMEOUT_MS = 5_000;
const PROCESS_TREE_TERM_GRACE_MS = 1_000;

const DAILY_STEPS = [
  {
    label: 'quality baseline',
    script: 'quality:baseline',
  },
  {
    label: 'performance gate',
    script: 'perf:guard',
  },
  {
    label: 'documentation gate',
    script: 'docs:validate',
  },
  {
    label: 'CodeGraph adapter gate',
    script: 'codegraph:adapter:gate',
  },
  {
    label: 'TypeScript typecheck',
    script: 'typecheck',
  },
  {
    label: 'key test matrix',
    script: 'test:run',
  },
];

const STRICT_STEPS = [
  {
    label: 'ratcheted quality baseline',
    script: 'quality:baseline:ratchet',
  },
  ...DAILY_STEPS.slice(1, -1),
  {
    label: 'verification test matrix',
    script: 'test:run:verify',
  },
];

const FULL_STEPS = [
  ...STRICT_STEPS.slice(0, -1),
  {
    label: 'full local test matrix',
    script: 'test:run:full',
  },
  {
    label: 'Playwright e2e',
    script: 'test:e2e',
  },
];

const PLANS = {
  daily: DAILY_STEPS,
  strict: STRICT_STEPS,
  full: FULL_STEPS,
};

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptions(argv) {
  let mode = 'daily';
  let printPlan = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--print-plan') {
      printPlan = true;
      continue;
    }
    if (arg === '--mode') {
      mode = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
      continue;
    }
    if (arg === 'daily' || arg === 'strict' || arg === 'full') {
      mode = arg;
      continue;
    }
    throw new Error(`Unknown health gate argument: ${arg}`);
  }

  if (!Object.hasOwn(PLANS, mode)) {
    throw new Error(`Unknown health gate mode "${mode}". Expected daily, strict, or full.`);
  }
  return { mode, printPlan };
}

function resolveNpmInvocation() {
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

function appendTail(current, chunk, limit) {
  const next = current + chunk.toString('utf8');
  if (next.length <= limit) {
    return next;
  }
  return next.slice(-limit);
}

function formatDuration(startedAt) {
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < 1000) {
    return `${elapsedMs}ms`;
  }
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

function writeFailureSummary(step, commandText, result, startedAt) {
  const reason = result.signal
    ? `signal ${result.signal}`
    : `exit code ${result.code ?? 1}`;
  process.stderr.write(`[health-gate] FAIL ${step.label} after ${formatDuration(startedAt)} (${reason})\n`);
  process.stderr.write(`[health-gate] command: ${commandText}\n`);

  const stdoutTail = result.stdoutTail.trimEnd();
  const stderrTail = result.stderrTail.trimEnd();
  if (stdoutTail) {
    process.stderr.write(`[health-gate] stdout tail:\n${stdoutTail}\n`);
  }
  if (stderrTail) {
    process.stderr.write(`[health-gate] stderr tail:\n${stderrTail}\n`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalDirectChild(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited between the cleanup decision and signal.
  }
}

function signalPosixProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function killWindowsProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let timeoutTimer = null;
    let killer;

    const finish = (succeeded) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(succeeded);
    };

    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }

    timeoutTimer = setTimeout(() => {
      signalDirectChild(killer, 'SIGKILL');
      finish(false);
    }, PROCESS_TREE_CLEANUP_TIMEOUT_MS);
    killer.once('error', () => finish(false));
    killer.once('close', (code) => finish(code === 0));
  });
}

async function terminateProcessTree(child) {
  const pid = child.pid;
  if (process.platform === 'win32') {
    const killedTree = await killWindowsProcessTree(pid);
    if (!killedTree) signalDirectChild(child, 'SIGKILL');
    return;
  }

  const signaledGroup = signalPosixProcessGroup(pid, 'SIGTERM');
  if (!signaledGroup) signalDirectChild(child, 'SIGTERM');
  await delay(PROCESS_TREE_TERM_GRACE_MS);
  if (!signalPosixProcessGroup(pid, 'SIGKILL')) {
    signalDirectChild(child, 'SIGKILL');
  }
}

function runNpmScript(step) {
  const invocation = resolveNpmInvocation();
  const args = [...invocation.argsPrefix, 'run', step.script];
  const commandText = `npm run ${step.script}`;
  const timeoutMs = parsePositiveIntegerEnv(
    'NANOFLOW_HEALTH_GATE_STEP_TIMEOUT_MS',
    DEFAULT_STEP_TIMEOUT_MS,
  );
  const tailLimit = parsePositiveIntegerEnv('NANOFLOW_HEALTH_GATE_TAIL_CHARS', DEFAULT_TAIL_CHARS);
  const startedAt = Date.now();

  process.stderr.write(`[health-gate] RUN ${step.label}: ${commandText}\n`);

  return new Promise((resolve) => {
    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    let cleanupPromise = null;
    let settled = false;

    const child = spawn(invocation.command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: invocation.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const timeoutTimer = setTimeout(() => {
      if (timedOut) return;
      timedOut = true;
      cleanupPromise = terminateProcessTree(child);
      void cleanupPromise.then(() => {
        settle({
          code: 1,
          signal: 'TIMEOUT',
          stdoutTail,
          stderrTail,
          timedOut: true,
          commandText,
          startedAt,
        });
      });
    }, timeoutMs);

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      Promise.resolve(cleanupPromise).then(() => resolve(result));
    };

    child.stdout?.on('data', (chunk) => {
      stdoutTail = appendTail(stdoutTail, chunk, tailLimit);
      process.stdout.write(chunk);
    });

    child.stderr?.on('data', (chunk) => {
      stderrTail = appendTail(stderrTail, chunk, tailLimit);
      process.stderr.write(chunk);
    });

    child.on('error', (error) => {
      stderrTail = appendTail(stderrTail, Buffer.from(error.message), tailLimit);
      settle({
        code: 1,
        signal: timedOut ? 'TIMEOUT' : null,
        stdoutTail,
        stderrTail,
        timedOut,
        commandText,
        startedAt,
      });
    });

    child.on('close', (code, signal) => {
      settle({
        code: timedOut ? 1 : code ?? 0,
        signal: timedOut ? 'TIMEOUT' : signal,
        stdoutTail,
        stderrTail,
        timedOut,
        commandText,
        startedAt,
      });
    });
  });
}

async function runPlan(mode, steps) {
  process.stderr.write(`[health-gate] mode=${mode}; steps=${steps.length}\n`);

  for (const step of steps) {
    const result = await runNpmScript(step);
    if (result.code !== 0 || result.signal) {
      writeFailureSummary(step, result.commandText, result, result.startedAt);
      process.exit(result.code || 1);
    }
    process.stderr.write(`[health-gate] PASS ${step.label} (${formatDuration(result.startedAt)})\n`);
  }

  process.stderr.write(`[health-gate] health gate passed (${mode})\n`);
}

async function main() {
  const { mode, printPlan } = parseOptions(process.argv.slice(2));
  const steps = PLANS[mode];

  if (printPlan) {
    process.stdout.write(`${JSON.stringify({ mode, steps }, null, 2)}\n`);
    return;
  }

  await runPlan(mode, steps);
}

main().catch((error) => {
  process.stderr.write(`[health-gate] unexpected failure: ${error.message}\n`);
  process.exit(1);
});
