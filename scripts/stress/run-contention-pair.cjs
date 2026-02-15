#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = process.cwd();
const defaultRounds = Number.parseInt(process.env.TEST_STRESS_ROUNDS || '30', 10);
const lanePattern = /^lane_[a-z_]+$/;

const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

const parsePositiveInt = (value, fallback) => {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
};

function parseArgs(argv) {
  let rounds = defaultRounds;
  let commandA = process.env.TEST_CONTENTION_CMD_A || 'lane_testbed_service';
  let commandB = process.env.TEST_CONTENTION_CMD_B || 'lane_testbed_component';
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

    if (arg.startsWith('--a=')) {
      commandA = arg.slice('--a='.length);
      continue;
    }
    if (arg === '--a') {
      commandA = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--b=')) {
      commandB = arg.slice('--b='.length);
      continue;
    }
    if (arg === '--b') {
      commandB = argv[i + 1];
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

  return {
    rounds,
    commandA,
    commandB,
    timingOut,
    passthrough,
  };
}

function normalizeCommand(command, passthrough) {
  const quotedArgs = passthrough.map((arg) => quote(arg)).join(' ');

  if (lanePattern.test(command)) {
    return `node scripts/run-test-matrix.cjs --lane=${quote(command)}${quotedArgs ? ` ${quotedArgs}` : ''}`;
  }

  return `${command}${quotedArgs ? ` ${quotedArgs}` : ''}`;
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
  const commandA = normalizeCommand(options.commandA, options.passthrough);
  const commandB = normalizeCommand(options.commandB, options.passthrough);

  console.log(`[contention] rounds=${options.rounds}`);
  console.log(`[contention] A=${commandA}`);
  console.log(`[contention] B=${commandB}`);

  const rounds = [];

  for (let round = 1; round <= options.rounds; round += 1) {
    console.log(`[contention] round ${round}/${options.rounds} start`);
    const wallStartedAt = Date.now();
    const [resultA, resultB] = await Promise.all([
      runCommand(commandA),
      runCommand(commandB),
    ]);

    const wallDurationMs = Date.now() - wallStartedAt;
    rounds.push({
      round,
      wallDurationMs,
      a: resultA,
      b: resultB,
    });

    console.log(
      `[contention] round ${round}/${options.rounds} ` +
      `wall=${wallDurationMs} a=${resultA.exitCode}/${resultA.durationMs} b=${resultB.exitCode}/${resultB.durationMs}`
    );
  }

  const failures = rounds.filter((sample) => sample.a.exitCode !== 0 || sample.b.exitCode !== 0);
  const wallDurations = rounds.map((sample) => sample.wallDurationMs);
  const durationsA = rounds.map((sample) => sample.a.durationMs);
  const durationsB = rounds.map((sample) => sample.b.durationMs);

  const summary = {
    rounds: options.rounds,
    commandA,
    commandB,
    failures: failures.length,
    medianWallMs: median(wallDurations),
    medianCommandAMs: median(durationsA),
    medianCommandBMs: median(durationsB),
    samples: rounds,
    createdAt: new Date().toISOString(),
  };

  writeTiming(options.timingOut, summary);

  console.log('[contention] summary:', JSON.stringify({
    rounds: summary.rounds,
    failures: summary.failures,
    medianWallMs: summary.medianWallMs,
    medianCommandAMs: summary.medianCommandAMs,
    medianCommandBMs: summary.medianCommandBMs,
  }));

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[contention] failed: ${message}`);
  process.exit(1);
});
