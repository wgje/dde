#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = process.cwd();
const DEFAULT_QUARANTINE_PATH = 'scripts/test-quarantine.json';
const DEFAULT_P95_THRESHOLD_MS = 1200;
const DEFAULT_FAILURE_RATE_THRESHOLD = 0.01;
const DEFAULT_RECOVERY_DAYS = 7;
const DEFAULT_MIN_SAMPLES = 1;
const UPDATED_BY = 'scripts/update-test-quarantine.cjs@v1';
const DEFAULT_SEED_FILES = [
  'src/app/features/flow/components/flow-task-detail.component.spec.ts',
  'src/services/user-session.service.spec.ts',
];

const toPosix = (value) => value.split(path.sep).join('/');
const toAbsolutePath = (target) => (path.isAbsolute(target) ? target : path.join(projectRoot, target));
const parsePathList = (value) => (value || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const parsePositiveNumber = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const parseNonNegativeNumber = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const normalizeRelativePath = (filePath) => {
  if (!filePath || typeof filePath !== 'string') return null;
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  const relative = toPosix(path.relative(projectRoot, absolute));
  return relative.startsWith('..') ? null : relative;
};

function quantile(values, q) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function parseArgs(argv) {
  let quarantinePath = DEFAULT_QUARANTINE_PATH;
  let quarantineOut = DEFAULT_QUARANTINE_PATH;
  let p95ThresholdMs = DEFAULT_P95_THRESHOLD_MS;
  let failureRateThreshold = DEFAULT_FAILURE_RATE_THRESHOLD;
  let recoveryDays = DEFAULT_RECOVERY_DAYS;
  let minSamples = DEFAULT_MIN_SAMPLES;
  let nowOverride = null;
  const vitestReports = [];
  const failureStats = [];
  const seedFiles = [...DEFAULT_SEED_FILES];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg.startsWith('--quarantine=')) {
      quarantinePath = arg.slice('--quarantine='.length);
      quarantineOut = quarantinePath;
      continue;
    }
    if (arg === '--quarantine') {
      quarantinePath = argv[i + 1];
      quarantineOut = quarantinePath;
      i += 1;
      continue;
    }

    if (arg.startsWith('--quarantine-out=')) {
      quarantineOut = arg.slice('--quarantine-out='.length);
      continue;
    }
    if (arg === '--quarantine-out') {
      quarantineOut = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--vitest-report=')) {
      vitestReports.push(...parsePathList(arg.slice('--vitest-report='.length)));
      continue;
    }
    if (arg === '--vitest-report') {
      vitestReports.push(...parsePathList(argv[i + 1]));
      i += 1;
      continue;
    }

    if (arg.startsWith('--failure-stats=')) {
      failureStats.push(...parsePathList(arg.slice('--failure-stats='.length)));
      continue;
    }
    if (arg === '--failure-stats') {
      failureStats.push(...parsePathList(argv[i + 1]));
      i += 1;
      continue;
    }

    if (arg.startsWith('--p95-ms=')) {
      const parsed = parsePositiveNumber(arg.slice('--p95-ms='.length));
      if (!parsed) {
        throw new Error(`Invalid --p95-ms value "${arg.slice('--p95-ms='.length)}"`);
      }
      p95ThresholdMs = parsed;
      continue;
    }
    if (arg === '--p95-ms') {
      const parsed = parsePositiveNumber(argv[i + 1]);
      if (!parsed) {
        throw new Error(`Invalid --p95-ms value "${argv[i + 1]}"`);
      }
      p95ThresholdMs = parsed;
      i += 1;
      continue;
    }

    if (arg.startsWith('--failure-rate-threshold=')) {
      const parsed = parseNonNegativeNumber(arg.slice('--failure-rate-threshold='.length));
      if (parsed === undefined) {
        throw new Error(`Invalid --failure-rate-threshold value "${arg.slice('--failure-rate-threshold='.length)}"`);
      }
      failureRateThreshold = parsed;
      continue;
    }
    if (arg === '--failure-rate-threshold') {
      const parsed = parseNonNegativeNumber(argv[i + 1]);
      if (parsed === undefined) {
        throw new Error(`Invalid --failure-rate-threshold value "${argv[i + 1]}"`);
      }
      failureRateThreshold = parsed;
      i += 1;
      continue;
    }

    if (arg.startsWith('--recovery-days=')) {
      const parsed = parsePositiveNumber(arg.slice('--recovery-days='.length));
      if (!parsed) {
        throw new Error(`Invalid --recovery-days value "${arg.slice('--recovery-days='.length)}"`);
      }
      recoveryDays = Math.floor(parsed);
      continue;
    }
    if (arg === '--recovery-days') {
      const parsed = parsePositiveNumber(argv[i + 1]);
      if (!parsed) {
        throw new Error(`Invalid --recovery-days value "${argv[i + 1]}"`);
      }
      recoveryDays = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg.startsWith('--min-samples=')) {
      const parsed = parsePositiveNumber(arg.slice('--min-samples='.length));
      if (!parsed) {
        throw new Error(`Invalid --min-samples value "${arg.slice('--min-samples='.length)}"`);
      }
      minSamples = Math.floor(parsed);
      continue;
    }
    if (arg === '--min-samples') {
      const parsed = parsePositiveNumber(argv[i + 1]);
      if (!parsed) {
        throw new Error(`Invalid --min-samples value "${argv[i + 1]}"`);
      }
      minSamples = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg.startsWith('--seed-file=')) {
      seedFiles.push(...parsePathList(arg.slice('--seed-file='.length)));
      continue;
    }
    if (arg === '--seed-file') {
      seedFiles.push(...parsePathList(argv[i + 1]));
      i += 1;
      continue;
    }

    if (arg.startsWith('--now=')) {
      nowOverride = arg.slice('--now='.length);
      continue;
    }
    if (arg === '--now') {
      nowOverride = argv[i + 1];
      i += 1;
      continue;
    }
  }

  const now = nowOverride ? new Date(nowOverride) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error(`Invalid --now value "${nowOverride}"`);
  }

  return {
    quarantinePath,
    quarantineOut,
    vitestReports,
    failureStats,
    p95ThresholdMs,
    failureRateThreshold,
    recoveryDays,
    minSamples,
    nowIso: now.toISOString(),
    seedFiles: [...new Set(seedFiles
      .map((file) => normalizeRelativePath(file))
      .filter(Boolean))].sort(),
  };
}

function collectFilesRecursive(rootDir, predicate) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile() && predicate(absolute)) {
        out.push(absolute);
      }
    }
  }

  out.sort();
  return out;
}

function loadJsonIfExists(filePath) {
  const absolute = toAbsolutePath(filePath);
  if (!fs.existsSync(absolute)) return null;
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function toIsoFromMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function toNormalizedFailureRate(value) {
  const n = parseNonNegativeNumber(value);
  if (n === undefined) return undefined;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return undefined;
}

function coerceEntry(raw, fallbackReason, fallbackTimestamp) {
  if (!raw || typeof raw !== 'object') return null;
  const file = normalizeRelativePath(raw.file ?? raw.path ?? raw.name);
  if (!file) return null;

  const firstSeenAt = typeof raw.firstSeenAt === 'string' && raw.firstSeenAt.trim()
    ? raw.firstSeenAt
    : fallbackTimestamp;
  const lastSeenAt = typeof raw.lastSeenAt === 'string' && raw.lastSeenAt.trim()
    ? raw.lastSeenAt
    : firstSeenAt;

  return {
    file,
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason : fallbackReason,
    firstSeenAt,
    lastSeenAt,
    healthyStreakDays: Math.max(0, Math.floor(parseNonNegativeNumber(raw.healthyStreakDays) ?? 0)),
    p95Ms: parsePositiveNumber(raw.p95Ms),
    failureRate7d: toNormalizedFailureRate(raw.failureRate7d),
    sampleCount: Math.floor(parseNonNegativeNumber(raw.sampleCount) ?? 0),
    failureSamples: Math.floor(parseNonNegativeNumber(raw.failureSamples) ?? 0),
  };
}

function loadExistingQuarantine(quarantinePath, nowIso) {
  const parsed = loadJsonIfExists(quarantinePath);
  const existing = new Map();
  if (!parsed) {
    return existing;
  }

  const defaultReason = typeof parsed.reason === 'string' && parsed.reason.trim()
    ? parsed.reason
    : 'manual';
  const fallbackTimestamp = typeof parsed.generatedAt === 'string' && parsed.generatedAt.trim()
    ? parsed.generatedAt
    : nowIso;

  const register = (entry) => {
    if (!entry) return;
    existing.set(entry.file, entry);
  };

  if (Array.isArray(parsed.entries)) {
    for (const entry of parsed.entries) {
      register(coerceEntry(entry, defaultReason, fallbackTimestamp));
    }
  }

  if (Array.isArray(parsed.files)) {
    for (const file of parsed.files) {
      if (typeof file !== 'string' || !file.trim()) continue;
      const normalized = normalizeRelativePath(file);
      if (!normalized || existing.has(normalized)) continue;
      register({
        file: normalized,
        reason: defaultReason,
        firstSeenAt: fallbackTimestamp,
        lastSeenAt: fallbackTimestamp,
        healthyStreakDays: 0,
        p95Ms: undefined,
        failureRate7d: undefined,
        sampleCount: 0,
        failureSamples: 0,
      });
    }
  }

  if (Array.isArray(parsed)) {
    for (const file of parsed) {
      if (typeof file !== 'string' || !file.trim()) continue;
      const normalized = normalizeRelativePath(file);
      if (!normalized || existing.has(normalized)) continue;
      register({
        file: normalized,
        reason: defaultReason,
        firstSeenAt: fallbackTimestamp,
        lastSeenAt: fallbackTimestamp,
        healthyStreakDays: 0,
        p95Ms: undefined,
        failureRate7d: undefined,
        sampleCount: 0,
        failureSamples: 0,
      });
    }
  }

  return existing;
}

function collectVitestMetrics(vitestReportPaths) {
  const loadedPaths = [];
  const metricsByFile = new Map();

  const ensureMetric = (file) => {
    const current = metricsByFile.get(file);
    if (current) return current;
    const next = {
      durations: [],
      runs: 0,
      failures: 0,
      lastSeenAt: null,
    };
    metricsByFile.set(file, next);
    return next;
  };

  const registerSuite = (suite) => {
    if (!suite || typeof suite !== 'object') return;
    const file = normalizeRelativePath(
      suite.name ?? suite.file ?? suite.filepath ?? suite.filename ?? suite.path
    );
    if (!file) return;

    const metric = ensureMetric(file);
    const duration = parsePositiveNumber(suite.duration)
      ?? (parsePositiveNumber(suite.endTime) && parsePositiveNumber(suite.startTime)
        ? Number(suite.endTime) - Number(suite.startTime)
        : undefined);
    if (duration) {
      metric.durations.push(duration);
    }

    metric.runs += 1;

    const assertionFailures = Array.isArray(suite.assertionResults)
      ? suite.assertionResults.some((assertion) => assertion?.status === 'failed')
      : false;
    const failed = suite.status === 'failed'
      || (parseNonNegativeNumber(suite.numFailingTests) ?? 0) > 0
      || assertionFailures;
    if (failed) {
      metric.failures += 1;
    }

    const lastSeenCandidate = toIsoFromMs(suite.endTime) ?? toIsoFromMs(suite.startTime);
    if (lastSeenCandidate && (!metric.lastSeenAt || metric.lastSeenAt < lastSeenCandidate)) {
      metric.lastSeenAt = lastSeenCandidate;
    }
  };

  for (const reportPath of vitestReportPaths) {
    const absolute = toAbsolutePath(reportPath);
    if (!fs.existsSync(absolute)) continue;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    } catch {
      continue;
    }

    loadedPaths.push(normalizeRelativePath(absolute));

    if (Array.isArray(parsed?.testResults)) {
      parsed.testResults.forEach(registerSuite);
    }
    if (Array.isArray(parsed?.files)) {
      parsed.files.forEach(registerSuite);
    }
    if (Array.isArray(parsed?.results)) {
      parsed.results.forEach(registerSuite);
    }
  }

  return {
    loadedPaths,
    metricsByFile,
  };
}

function collectFailureMetrics(failureStatPaths) {
  const loadedPaths = [];
  const metricsByFile = new Map();

  const ensureMetric = (file) => {
    const current = metricsByFile.get(file);
    if (current) return current;
    const next = {
      runs: 0,
      failures: 0,
      failureRateSum: 0,
      failureRateCount: 0,
      lastSeenAt: null,
    };
    metricsByFile.set(file, next);
    return next;
  };

  const register = (rawEntry) => {
    if (!rawEntry || typeof rawEntry !== 'object') return;
    const file = normalizeRelativePath(rawEntry.file ?? rawEntry.path ?? rawEntry.name);
    if (!file) return;

    const metric = ensureMetric(file);
    const runs = parseNonNegativeNumber(
      rawEntry.runs ?? rawEntry.totalRuns ?? rawEntry.total ?? rawEntry.sampleCount ?? rawEntry.samples
    );
    const failures = parseNonNegativeNumber(
      rawEntry.failures ?? rawEntry.failed ?? rawEntry.failureCount ?? rawEntry.failedRuns
    );
    const failureRate = toNormalizedFailureRate(
      rawEntry.failureRate ?? rawEntry.failure_rate ?? rawEntry.flakeRate
    );

    if (runs !== undefined) {
      metric.runs += runs;
    }
    if (failures !== undefined) {
      metric.failures += failures;
    }
    if (failureRate !== undefined) {
      metric.failureRateSum += failureRate;
      metric.failureRateCount += 1;
    }

    const lastSeenRaw = rawEntry.lastSeenAt ?? rawEntry.updatedAt ?? rawEntry.lastUpdatedAt;
    if (typeof lastSeenRaw === 'string' && lastSeenRaw.trim()) {
      if (!metric.lastSeenAt || metric.lastSeenAt < lastSeenRaw) {
        metric.lastSeenAt = lastSeenRaw;
      }
    }
  };

  for (const statPath of failureStatPaths) {
    const absolute = toAbsolutePath(statPath);
    if (!fs.existsSync(absolute)) continue;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    } catch {
      continue;
    }

    loadedPaths.push(normalizeRelativePath(absolute));

    const candidates = [];
    if (Array.isArray(parsed)) {
      candidates.push(...parsed);
    }
    if (Array.isArray(parsed?.entries)) {
      candidates.push(...parsed.entries);
    }
    if (Array.isArray(parsed?.files)) {
      candidates.push(...parsed.files);
    }
    if (parsed?.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) {
      for (const [file, value] of Object.entries(parsed.files)) {
        if (value && typeof value === 'object') {
          candidates.push({ file, ...value });
        }
      }
    }

    for (const entry of candidates) {
      register(entry);
    }
  }

  return {
    loadedPaths,
    metricsByFile,
  };
}

function writeJsonFile(targetPath, payload) {
  const absolute = toAbsolutePath(targetPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(payload, null, 2) + '\n');
}

function listDefaultVitestReports() {
  return collectFilesRecursive(
    toAbsolutePath('test-results'),
    (absolute) => absolute.endsWith('.json') && path.basename(absolute).includes('vitest-report')
  ).map((absolute) => normalizeRelativePath(absolute));
}

function listDefaultFailureStats() {
  return collectFilesRecursive(
    toAbsolutePath('test-results'),
    (absolute) => absolute.endsWith('.json') && path.basename(absolute).includes('failure-stats')
  ).map((absolute) => normalizeRelativePath(absolute));
}

function round(value, fractionDigits) {
  if (!Number.isFinite(value)) return undefined;
  const factor = 10 ** fractionDigits;
  return Math.round(value * factor) / factor;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const seedFileSet = new Set(options.seedFiles);
  const vitestReports = options.vitestReports.length > 0
    ? options.vitestReports
    : listDefaultVitestReports();
  const failureStats = options.failureStats.length > 0
    ? options.failureStats
    : listDefaultFailureStats();

  const existingEntries = loadExistingQuarantine(options.quarantinePath, options.nowIso);
  for (const seedFile of options.seedFiles) {
    if (!existingEntries.has(seedFile)) {
      existingEntries.set(seedFile, {
        file: seedFile,
        reason: 'manual_seed',
        firstSeenAt: options.nowIso,
        lastSeenAt: options.nowIso,
        healthyStreakDays: 0,
        p95Ms: undefined,
        failureRate7d: undefined,
        sampleCount: 0,
        failureSamples: 0,
      });
    }
  }

  const vitestMetrics = collectVitestMetrics(vitestReports);
  const failureMetrics = collectFailureMetrics(failureStats);

  const candidateFiles = new Set([
    ...existingEntries.keys(),
    ...vitestMetrics.metricsByFile.keys(),
    ...failureMetrics.metricsByFile.keys(),
  ]);

  const nextEntries = [];
  const sortedCandidates = [...candidateFiles].sort((a, b) => a.localeCompare(b));

  for (const file of sortedCandidates) {
    const isSeedFile = seedFileSet.has(file);
    const existing = existingEntries.get(file);
    const vitestMetric = vitestMetrics.metricsByFile.get(file);
    const failureMetric = failureMetrics.metricsByFile.get(file);

    const p95Ms = quantile(vitestMetric?.durations ?? [], 0.95);

    let failureRate7d;
    let sampleCount = vitestMetric?.runs ?? 0;
    let failureSamples = vitestMetric?.failures ?? 0;

    if (failureMetric) {
      if (failureMetric.runs > 0) {
        failureRate7d = failureMetric.failures / failureMetric.runs;
        sampleCount = Math.max(sampleCount, Math.floor(failureMetric.runs));
        failureSamples = Math.max(failureSamples, Math.floor(failureMetric.failures));
      } else if (failureMetric.failureRateCount > 0) {
        failureRate7d = failureMetric.failureRateSum / failureMetric.failureRateCount;
      }
    } else if ((vitestMetric?.runs ?? 0) > 0) {
      failureRate7d = vitestMetric.failures / vitestMetric.runs;
    }

    const reasons = [];
    if (
      p95Ms !== undefined
      && (vitestMetric?.runs ?? 0) >= options.minSamples
      && p95Ms > options.p95ThresholdMs
    ) {
      reasons.push(`p95>${Math.round(options.p95ThresholdMs)}ms`);
    }
    if (
      failureRate7d !== undefined
      && sampleCount >= options.minSamples
      && failureRate7d > options.failureRateThreshold
    ) {
      reasons.push(`fail-rate>${(options.failureRateThreshold * 100).toFixed(2)}%`);
    }

    const observedNow = Boolean(vitestMetric || failureMetric);
    const isFlagged = reasons.length > 0;

    if (isFlagged) {
      nextEntries.push({
        file,
        reason: reasons.join(' | '),
        firstSeenAt: existing?.firstSeenAt ?? options.nowIso,
        lastSeenAt: options.nowIso,
        healthyStreakDays: 0,
        p95Ms: round(p95Ms ?? existing?.p95Ms, 2),
        failureRate7d: round(failureRate7d ?? existing?.failureRate7d, 6),
        sampleCount,
        failureSamples,
      });
      continue;
    }

    if (!existing) {
      continue;
    }

    const nextHealthyStreak = observedNow
      ? existing.healthyStreakDays + 1
      : existing.healthyStreakDays;
    if (!isSeedFile && observedNow && nextHealthyStreak >= options.recoveryDays) {
      continue;
    }

    nextEntries.push({
      file,
      reason: existing.reason,
      firstSeenAt: existing.firstSeenAt,
      lastSeenAt: observedNow ? options.nowIso : existing.lastSeenAt,
      healthyStreakDays: nextHealthyStreak,
      p95Ms: round(p95Ms ?? existing.p95Ms, 2),
      failureRate7d: round(failureRate7d ?? existing.failureRate7d, 6),
      sampleCount: sampleCount || existing.sampleCount || 0,
      failureSamples: failureSamples || existing.failureSamples || 0,
    });
  }

  const entries = nextEntries
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((entry) => ({
      ...entry,
      sampleCount: Math.max(0, Math.floor(entry.sampleCount ?? 0)),
      failureSamples: Math.max(0, Math.floor(entry.failureSamples ?? 0)),
      healthyStreakDays: Math.max(0, Math.floor(entry.healthyStreakDays ?? 0)),
    }));

  const output = {
    schemaVersion: 2,
    generatedAt: options.nowIso,
    updatedBy: UPDATED_BY,
    thresholds: {
      p95Ms: options.p95ThresholdMs,
      failureRate7d: options.failureRateThreshold,
      recoveryDays: options.recoveryDays,
      minSamples: options.minSamples,
    },
    files: entries.map((entry) => entry.file),
    entries,
    sources: {
      seedFilesPinned: [...seedFileSet].sort(),
      vitestReportsRequested: vitestReports,
      vitestReportsLoaded: vitestMetrics.loadedPaths,
      failureStatsRequested: failureStats,
      failureStatsLoaded: failureMetrics.loadedPaths,
    },
  };

  writeJsonFile(options.quarantineOut, output);

  console.log(`[quarantine] updated ${options.quarantineOut}`);
  console.log(`[quarantine] entries=${entries.length} vitestLoaded=${vitestMetrics.loadedPaths.length} failureStatsLoaded=${failureMetrics.loadedPaths.length}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[quarantine] failed: ${message}`);
  process.exit(1);
}
