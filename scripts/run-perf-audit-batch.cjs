#!/usr/bin/env node
/**
 * 批量性能回归执行器
 *
 * 用法：
 * node scripts/run-perf-audit-batch.cjs --date=YYYY-MM-DD --rounds=5 --strict-thresholds=1
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const [rawKey, rawValue] = token.slice(2).split('=');
    args[rawKey] = rawValue ?? '1';
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

function countMatches(content, pattern) {
  const matched = content.match(pattern);
  return matched ? matched.length : 0;
}

function extractMetric(content, pattern) {
  const values = [];
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = pattern.exec(content)) !== null) {
    values.push(Number(match[1]));
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const date = args['date'] || todayDateString();
const rounds = Number(args['rounds'] || 5);
const strictThresholds = String(args['strict-thresholds'] || '0') === '1';

if (!Number.isFinite(rounds) || rounds < 1) {
  console.error('[perf-audit-batch] --rounds 必须是 >= 1 的整数');
  process.exit(1);
}

const logsDir = path.join(ROOT, 'tmp', 'perf-audit', date);
const resultDir = path.join(ROOT, 'test-results', 'perf', date);
const runStatusPath = path.join(logsDir, 'run-status.tsv');
const summaryPath = path.join(resultDir, 'summary.txt');

ensureDir(logsDir);
ensureDir(resultDir);

const suites = [
  {
    name: 'weak-network-startup',
    short: 'weak-startup',
    rounds,
    cmd: ['npx', 'playwright', 'test', 'e2e/perf/weak-network-startup.spec.ts', '--reporter=line'],
    env: { PERF_BUDGET_TEST: '1' },
  },
  {
    name: 'weak-network-budget',
    short: 'weak-budget',
    rounds,
    cmd: ['npx', 'playwright', 'test', 'e2e/weak-network-budget.spec.ts', '--reporter=line'],
    env: { PERF_BUDGET_TEST: '1' },
  },
  {
    name: 'resume-budget',
    short: 'resume',
    rounds,
    cmd: ['npx', 'playwright', 'test', 'e2e/perf/resume-budget.spec.ts', '--reporter=line'],
    env: { PERF_BUDGET_TEST: '1' },
  },
  {
    name: 'auth-flow',
    short: 'auth-flow',
    rounds: 1,
    cmd: ['npx', 'playwright', 'test', 'e2e/critical-paths/auth-flow.spec.ts', '--reporter=line'],
    env: {},
  },
  {
    name: 'task-crud',
    short: 'task-crud',
    rounds: 1,
    cmd: ['npx', 'playwright', 'test', 'e2e/critical-paths/task-crud.spec.ts', '--reporter=line'],
    env: {},
  },
  {
    name: 'sync-flow-lite',
    short: 'sync-flow-lite',
    rounds: 1,
    cmd: [
      'npx',
      'playwright',
      'test',
      'e2e/critical-paths/sync-flow.spec.ts',
      '--reporter=line',
      '--grep',
      '任务拖拽应更新父级关系|离线修改应在重连后同步',
    ],
    env: {},
  },
];

const runStatusRows = ['suite\trun\texit_code\tstarted_at\tended_at\tlog_file'];
const fullLogs = [];
let totalRuns = 0;
let passRuns = 0;
let failRuns = 0;

for (const suite of suites) {
  for (let runIndex = 1; runIndex <= suite.rounds; runIndex += 1) {
    totalRuns += 1;
    const startedAt = nowIso();
    const logFile = path.join(logsDir, `${suite.short}-${runIndex}.log`);

    console.log(`[perf-audit-batch] RUN ${suite.name} #${runIndex}`);
    const spawned = spawnSync(suite.cmd[0], suite.cmd.slice(1), {
      cwd: ROOT,
      env: { ...process.env, ...suite.env },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 50,
    });

    const stdout = spawned.stdout || '';
    const stderr = spawned.stderr || '';
    const content = `${stdout}${stderr ? `\n${stderr}` : ''}`;
    writeFile(logFile, content);
    fullLogs.push({ suite: suite.name, run: runIndex, content });

    const endedAt = nowIso();
    const exitCode = typeof spawned.status === 'number' ? spawned.status : 1;
    if (exitCode === 0) {
      passRuns += 1;
    } else {
      failRuns += 1;
    }

    runStatusRows.push(
      `${suite.name}\t${runIndex}\t${exitCode}\t${startedAt}\t${endedAt}\t${path.relative(ROOT, logFile)}`
    );
  }
}

writeFile(runStatusPath, `${runStatusRows.join('\n')}\n`);
writeFile(path.join(resultDir, 'run-status.tsv'), `${runStatusRows.join('\n')}\n`);

const allLogText = fullLogs.map((item) => item.content).join('\n');
const loginSamples = countMatches(allLogText, /\[(?:weak-startup|weak-budget|resume-budget)\] .*login=[01]/g);
const loginSuccess = countMatches(allLogText, /\[(?:weak-startup|weak-budget|resume-budget)\] .*login=1/g);
const warmSamples = countMatches(allLogText, /\[(?:weak-startup|weak-budget)\] .*path=warm/g);
const warmZeroSamples = countMatches(allLogText, /\[(?:weak-startup|weak-budget)\] .*warmZero=1/g);

const resumeZeroValues = extractMetric(allLogText, /\[resume-budget\].*interactionZero=(\d+)/g);
const resumeSamples = resumeZeroValues.length;
const resumeZeroSamples = resumeZeroValues.reduce((sum, next) => sum + (next > 0 ? 1 : 0), 0);

const loginSuccessRate = loginSamples > 0 ? loginSuccess / loginSamples : 1;
const warmZeroRatio = warmSamples > 0 ? warmZeroSamples / warmSamples : 0;
const resumeZeroRatio = resumeSamples > 0 ? resumeZeroSamples / resumeSamples : 0;
const passRate = totalRuns > 0 ? passRuns / totalRuns : 0;

const thresholdViolations = [];
if (strictThresholds) {
  if (warmZeroRatio > 0.4) {
    thresholdViolations.push(
      `warm-path zero-fetch 占比超限: ${(warmZeroRatio * 100).toFixed(1)}% > 40%`
    );
  }
  if (loginSuccessRate < 0.95) {
    thresholdViolations.push(
      `登录前置成功率不足: ${(loginSuccessRate * 100).toFixed(1)}% < 95%`
    );
  }
  if (resumeZeroRatio > 0.2) {
    thresholdViolations.push(
      `resume.interaction_ready_ms=0 频率超限: ${(resumeZeroRatio * 100).toFixed(1)}% > 20%`
    );
  }
}

const summaryLines = [
  `generated_at=${nowIso()}`,
  `logs_dir=${path.relative(ROOT, logsDir)}`,
  `run_status=${path.relative(ROOT, runStatusPath)}`,
  `total_runs=${totalRuns}`,
  `pass=${passRuns}`,
  `fail=${failRuns}`,
  `pass_rate=${(passRate * 100).toFixed(1)}%`,
  `strict_thresholds=${strictThresholds ? 1 : 0}`,
  `warm_zero_ratio=${(warmZeroRatio * 100).toFixed(1)}%`,
  `login_success_rate=${(loginSuccessRate * 100).toFixed(1)}%`,
  `resume_zero_ratio=${(resumeZeroRatio * 100).toFixed(1)}%`,
  `threshold_violations=${thresholdViolations.length}`,
];

if (thresholdViolations.length > 0) {
  for (const violation of thresholdViolations) {
    summaryLines.push(`violation=${violation}`);
  }
}

writeFile(summaryPath, `${summaryLines.join('\n')}\n`);

console.log(`[perf-audit-batch] total=${totalRuns} pass=${passRuns} fail=${failRuns}`);
console.log(`[perf-audit-batch] warm_zero_ratio=${(warmZeroRatio * 100).toFixed(1)}%`);
console.log(`[perf-audit-batch] login_success_rate=${(loginSuccessRate * 100).toFixed(1)}%`);
console.log(`[perf-audit-batch] resume_zero_ratio=${(resumeZeroRatio * 100).toFixed(1)}%`);
console.log(`[perf-audit-batch] summary=${path.relative(ROOT, summaryPath)}`);

if (failRuns > 0 || thresholdViolations.length > 0) {
  if (thresholdViolations.length > 0) {
    console.error('[perf-audit-batch] threshold violations:');
    for (const violation of thresholdViolations) {
      console.error(`  - ${violation}`);
    }
  }
  process.exit(1);
}
