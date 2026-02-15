#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = process.cwd();
const defaultRounds = Number.parseInt(process.env.TEST_STRESS_ROUNDS || '10', 10);

const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

const parsePositiveInt = (value, fallback) => {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
};

function parseArgs(argv) {
  let rounds = defaultRounds;
  let lane;
  let cmd;
  let timingOut;
  const passthrough = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--rounds=')) {
      rounds = parsePositiveInt(arg.slice('--rounds='.length), rounds);
      continue;
    }
    if (arg === '--rounds') {
      rounds = parsePositiveInt(argv[i + 1], rounds);
      i += 1;
      continue;
    }

    if (arg.startsWith('--lane=')) {
      lane = arg.slice('--lane='.length);
      continue;
    }
    if (arg === '--lane') {
      lane = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--cmd=')) {
      cmd = arg.slice('--cmd='.length);
      continue;
    }
    if (arg === '--cmd') {
      cmd = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--timing-out=')) {
      timingOut = arg.slice('--timing-out='.length);
      continue;
    }
    if (arg === '--timing-out') {
      timingOut = argv[i + 1];
      i += 1;
      continue;
    }

    passthrough.push(arg);
  }

  return { rounds, lane, cmd, timingOut, passthrough };
}

function resolveCommand(options) {
  const args = options.passthrough.map((arg) => quote(arg)).join(' ');

  if (options.cmd) {
    return `${options.cmd}${args ? ` ${args}` : ''}`;
  }

  if (options.lane) {
    return `node scripts/run-test-matrix.cjs --lane=${quote(options.lane)}${args ? ` ${args}` : ''}`;
  }

  return `npm run test:run --${args ? ` ${args}` : ''}`;
}

function runCommand(command) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('bash', ['-lc', command], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      resolve({
        exitCode: signal ? 1 : (code ?? 1),
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('error', () => {
      resolve({ exitCode: 1, durationMs: Date.now() - startedAt });
    });
  });
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function writeTiming(timingOut, payload) {
  if (!timingOut) return;
  const absolutePath = path.isAbsolute(timingOut)
    ? timingOut
    : path.join(projectRoot, timingOut);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(payload, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = resolveCommand(options);

  console.log(`[stress] command: ${command}`);
  console.log(`[stress] rounds: ${options.rounds}`);

  const rounds = [];
  for (let round = 1; round <= options.rounds; round += 1) {
    console.log(`[stress] round ${round}/${options.rounds} start`);
    const result = await runCommand(command);
    rounds.push({ round, ...result });
    console.log(`[stress] round ${round}/${options.rounds} exit=${result.exitCode} durationMs=${result.durationMs}`);
  }

  const failures = rounds.filter((round) => round.exitCode !== 0);
  const durations = rounds.map((round) => round.durationMs);
  const summary = {
    command,
    rounds: options.rounds,
    failures: failures.length,
    medianMs: median(durations),
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    samples: rounds,
    createdAt: new Date().toISOString(),
  };

  writeTiming(options.timingOut, summary);

  console.log('[stress] summary:', JSON.stringify({
    rounds: summary.rounds,
    failures: summary.failures,
    medianMs: summary.medianMs,
    minMs: summary.minMs,
    maxMs: summary.maxMs,
  }));

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[stress] failed: ${message}`);
  process.exit(1);
});
