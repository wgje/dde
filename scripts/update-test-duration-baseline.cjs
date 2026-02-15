#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = process.cwd();
const DEFAULT_BASELINE = 'scripts/test-duration-baseline.json';
const DEFAULT_QUARANTINE = 'scripts/test-quarantine.json';
const DEFAULT_ALPHA = 0.35;
const TIMING_FILE_REGEX = /vitest-shard-\d+\.json$/;
const UPDATED_BY = 'scripts/update-test-duration-baseline.cjs@v2';

const toPosix = (value) => value.split(path.sep).join('/');

const parsePathList = (value) => {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const toAbsolutePath = (target) => (path.isAbsolute(target) ? target : path.join(projectRoot, target));

const normalizeRelativePath = (target) => {
  const absolute = path.isAbsolute(target) ? target : path.join(projectRoot, target);
  return toPosix(path.relative(projectRoot, absolute));
};

const parsePositiveNumber = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function parseArgs(argv) {
  let baselinePath = DEFAULT_BASELINE;
  let quarantinePath = DEFAULT_QUARANTINE;
  let alpha = DEFAULT_ALPHA;
  const timingInputs = [];
  const vitestReports = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg.startsWith('--baseline=')) {
      baselinePath = arg.slice('--baseline='.length);
      continue;
    }
    if (arg === '--baseline') {
      baselinePath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--quarantine=')) {
      quarantinePath = arg.slice('--quarantine='.length);
      continue;
    }
    if (arg === '--quarantine') {
      quarantinePath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--alpha=')) {
      const parsed = parsePositiveNumber(arg.slice('--alpha='.length));
      if (!parsed || parsed >= 1) {
        throw new Error(`Invalid --alpha value: ${arg.slice('--alpha='.length)} (expected 0 < alpha < 1)`);
      }
      alpha = parsed;
      continue;
    }
    if (arg === '--alpha') {
      const parsed = parsePositiveNumber(argv[i + 1]);
      if (!parsed || parsed >= 1) {
        throw new Error(`Invalid --alpha value: ${argv[i + 1]} (expected 0 < alpha < 1)`);
      }
      alpha = parsed;
      i += 1;
      continue;
    }

    if (arg.startsWith('--timing-in=')) {
      timingInputs.push(...parsePathList(arg.slice('--timing-in='.length)));
      continue;
    }
    if (arg === '--timing-in') {
      timingInputs.push(...parsePathList(argv[i + 1]));
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
  }

  if (Math.abs(alpha - DEFAULT_ALPHA) > 1e-9) {
    throw new Error(`--alpha is fixed at ${DEFAULT_ALPHA}`);
  }

  return {
    baselinePath,
    quarantinePath,
    alpha,
    timingInputs,
    vitestReports,
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
  if (!fs.existsSync(absolute)) {
    return null;
  }

  const raw = fs.readFileSync(absolute, 'utf8');
  return JSON.parse(raw);
}

function loadQuarantineList(quarantinePath) {
  const parsed = loadJsonIfExists(quarantinePath);
  if (!parsed) {
    return [];
  }

  const files = [];
  if (Array.isArray(parsed)) {
    files.push(...parsed);
  }
  if (Array.isArray(parsed.files)) {
    files.push(...parsed.files);
  }
  if (Array.isArray(parsed.entries)) {
    for (const entry of parsed.entries) {
      if (!entry || typeof entry !== 'object') continue;
      const maybeFile = entry.file ?? entry.path ?? entry.name;
      if (typeof maybeFile === 'string' && maybeFile.trim()) {
        files.push(maybeFile);
      }
    }
  }

  return files
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => normalizeRelativePath(value));
}

function loadExistingBaseline(baselinePath) {
  const parsed = loadJsonIfExists(baselinePath);
  if (!parsed || typeof parsed !== 'object') {
    return {
      schemaVersion: 2,
      tasks: {},
      files: {},
      laneAverages: {},
      quarantine: [],
      samples: {},
      updatedBy: UPDATED_BY,
    };
  }

  const tasks = parsed.tasks && typeof parsed.tasks === 'object' && !Array.isArray(parsed.tasks)
    ? { ...parsed.tasks }
    : {};
  const files = parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)
    ? { ...parsed.files }
    : {};
  const laneAverages = parsed.laneAverages && typeof parsed.laneAverages === 'object' && !Array.isArray(parsed.laneAverages)
    ? { ...parsed.laneAverages }
    : {};

  const quarantine = Array.isArray(parsed.quarantine)
    ? parsed.quarantine
    : [];

  return {
    schemaVersion: 2,
    tasks,
    files,
    laneAverages,
    quarantine,
    samples: parsed.samples && typeof parsed.samples === 'object' && !Array.isArray(parsed.samples)
      ? { ...parsed.samples }
      : {},
    updatedBy: typeof parsed.updatedBy === 'string' && parsed.updatedBy.trim()
      ? parsed.updatedBy
      : UPDATED_BY,
  };
}

function mean(values) {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countSamples(sampleMap) {
  let total = 0;
  for (const samples of sampleMap.values()) {
    total += samples.length;
  }
  return total;
}

function ewma(prev, current, alpha) {
  const p = parsePositiveNumber(prev);
  const c = parsePositiveNumber(current);
  if (!c) return p;
  if (!p) return c;
  return p * (1 - alpha) + c * alpha;
}

function collectTimingObservations(timingPaths) {
  const laneSamples = new Map();
  const laneSharedSamples = new Map();
  const fileSamples = new Map();
  const loadedPaths = [];
  const shardTimingPaths = new Set();

  const addSample = (targetMap, key, value) => {
    const n = parsePositiveNumber(value);
    if (!n || !key) return;
    const bucket = targetMap.get(key) ?? [];
    bucket.push(n);
    targetMap.set(key, bucket);
  };

  const registerFileDurationsObject = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [file, value] of Object.entries(obj)) {
      const rel = normalizeRelativePath(file);
      if (rel.startsWith('..')) continue;
      addSample(fileSamples, rel, value);
    }
  };

  const registerVitestResults = (results) => {
    if (!Array.isArray(results)) return;
    for (const entry of results) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') continue;
      const duration = parsePositiveNumber(entry.duration)
        ?? (parsePositiveNumber(entry.endTime) && parsePositiveNumber(entry.startTime)
          ? Number(entry.endTime) - Number(entry.startTime)
          : undefined);
      if (!duration) continue;
      const rel = normalizeRelativePath(entry.name);
      if (rel.startsWith('..')) continue;
      addSample(fileSamples, rel, duration);
    }
  };

  for (const timingPath of timingPaths) {
    const absolute = toAbsolutePath(timingPath);
    if (!fs.existsSync(absolute)) continue;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    } catch {
      continue;
    }

    loadedPaths.push(normalizeRelativePath(absolute));

    if (!parsed || typeof parsed !== 'object') continue;

    if (TIMING_FILE_REGEX.test(path.basename(absolute)) || /^(\d+)\/(\d+)$/.test(String(parsed.shard ?? ''))) {
      shardTimingPaths.add(normalizeRelativePath(absolute));
    }

    registerFileDurationsObject(parsed.files);
    registerFileDurationsObject(parsed.fileDurations);
    registerVitestResults(parsed.testResults);

    if (Array.isArray(parsed.lanes)) {
      for (const lane of parsed.lanes) {
        if (!lane || typeof lane !== 'object' || typeof lane.laneName !== 'string') continue;

        if (parsePositiveNumber(lane.durationMs)) {
          addSample(laneSharedSamples, lane.laneName, lane.durationMs);
          addSample(laneSamples, `${lane.laneName}/shared`, lane.durationMs);
        }

        if (Array.isArray(lane.segments)) {
          for (const segment of lane.segments) {
            if (!segment || typeof segment !== 'object' || typeof segment.segmentName !== 'string') continue;
            addSample(laneSamples, `${lane.laneName}/${segment.segmentName}`, segment.durationMs);
          }
        }
      }
    }
  }

  return {
    loadedPaths,
    shardTimingPaths: [...shardTimingPaths].sort(),
    laneSamples,
    laneSharedSamples,
    fileSamples,
  };
}

function listDefaultTimingInputs() {
  const roots = [
    toAbsolutePath('test-results'),
  ];

  const files = [];
  for (const root of roots) {
    files.push(...collectFilesRecursive(root, (absolute) => TIMING_FILE_REGEX.test(path.basename(absolute))));
  }

  const unique = [...new Set(files.map((absolute) => normalizeRelativePath(absolute)))];
  unique.sort();
  return unique;
}

function writeBaseline(baselinePath, payload) {
  const absolute = toAbsolutePath(baselinePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(payload, null, 2) + '\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const timingInputs = options.timingInputs.length > 0
    ? options.timingInputs
    : listDefaultTimingInputs();

  const existing = loadExistingBaseline(options.baselinePath);
  const quarantineList = loadQuarantineList(options.quarantinePath);

  const vitestReportInputs = options.vitestReports.length > 0
    ? options.vitestReports
    : collectFilesRecursive(toAbsolutePath('test-results'), (absolute) => path.basename(absolute).includes('vitest-report'))
      .map((absolute) => normalizeRelativePath(absolute));

  const timingObservations = collectTimingObservations(timingInputs);
  const vitestObservations = collectTimingObservations(vitestReportInputs);
  const shardTimingFilesLoaded = timingObservations.shardTimingPaths.length;
  const canUpdateLaneDurations = shardTimingFilesLoaded >= 2;

  const tasks = { ...existing.tasks };
  if (canUpdateLaneDurations) {
    for (const [taskName, samples] of timingObservations.laneSamples.entries()) {
      const observedMean = mean(samples);
      const nextValue = ewma(tasks[taskName], observedMean, options.alpha);
      if (nextValue) {
        tasks[taskName] = Math.round(nextValue);
      }
    }
  }

  const laneAverages = { ...existing.laneAverages };
  if (canUpdateLaneDurations) {
    for (const [laneName, samples] of timingObservations.laneSharedSamples.entries()) {
      const observedMean = mean(samples);
      const previous = laneAverages[laneName] ?? tasks[`${laneName}/shared`];
      const nextValue = ewma(previous, observedMean, options.alpha);
      if (nextValue) {
        laneAverages[laneName] = Math.round(nextValue);
      }
    }
  }

  const files = { ...existing.files };
  if (vitestObservations.loadedPaths.length > 0) {
    for (const [fileName, samples] of vitestObservations.fileSamples.entries()) {
      const observedMean = mean(samples);
      const nextValue = ewma(files[fileName], observedMean, options.alpha);
      if (nextValue) {
        files[fileName] = Math.round(nextValue);
      }
    }
  }

  const quarantine = [...new Set(quarantineList)].sort();

  const baseline = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    source: 'ewma-update',
    alpha: options.alpha,
    tasks,
    files,
    laneAverages,
    quarantine,
    samples: {
      timingFilesLoaded: timingObservations.loadedPaths.length,
      shardTimingFilesLoaded,
      vitestReportsLoaded: vitestObservations.loadedPaths.length,
      laneTaskSampleCount: countSamples(timingObservations.laneSamples),
      laneAverageSampleCount: countSamples(timingObservations.laneSharedSamples),
      fileSampleCount: countSamples(vitestObservations.fileSamples),
    },
    updatedBy: UPDATED_BY,
    inputs: {
      timingRequested: timingInputs,
      timingLoaded: timingObservations.loadedPaths,
      shardTimingLoaded: timingObservations.shardTimingPaths,
      vitestReportsRequested: vitestReportInputs,
      vitestReportsLoaded: vitestObservations.loadedPaths,
    },
  };

  writeBaseline(options.baselinePath, baseline);

  console.log(`[baseline] updated ${options.baselinePath}`);
  console.log(`[baseline] timingLoaded=${timingObservations.loadedPaths.length} shardTimingLoaded=${shardTimingFilesLoaded} laneUpdates=${canUpdateLaneDurations ? 'enabled' : 'skipped'}`);
  console.log(`[baseline] vitestReportsLoaded=${vitestObservations.loadedPaths.length} fileBuckets=${vitestObservations.fileSamples.size}`);
  console.log(`[baseline] quarantine=${quarantine.length} alpha=${options.alpha}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[baseline] failed: ${message}`);
  process.exit(1);
}
