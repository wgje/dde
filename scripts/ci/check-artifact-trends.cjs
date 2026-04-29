#!/usr/bin/env node
/**
 * Compare Cloudflare deployment artifact metrics against the last main
 * baseline. Growth above 15% is a warning; growth above 30% fails.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_CURRENT = path.join(REPO_ROOT, 'dist', 'browser', 'artifact-manifest.json');
const DEFAULT_BASELINE = path.join(REPO_ROOT, 'docs', 'cloudflare-artifact-baseline.json');
const WARN_RATIO = 0.15;
const FAIL_RATIO = 0.30;

const METRICS = [
  'fileCount',
  'totalBytes',
  'rootJsCount',
  'headerRuleCount',
  'ngswAssetCount',
  'gojsFlowChunkBytes',
];

function parseArgs(argv) {
  const args = {
    current: process.env.ARTIFACT_TREND_CURRENT || DEFAULT_CURRENT,
    baseline: process.env.ARTIFACT_TREND_BASELINE || DEFAULT_BASELINE,
    allowMissingBaseline: false,
  };

  for (const arg of argv) {
    if (arg === '--allow-missing-baseline') args.allowMissingBaseline = true;
    else if (arg.startsWith('--current=')) args.current = arg.slice('--current='.length);
    else if (arg.startsWith('--baseline=')) args.baseline = arg.slice('--baseline='.length);
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readManifest(filepath) {
  if (!fs.existsSync(filepath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || !parsed.metrics || typeof parsed.metrics !== 'object') {
    throw new Error(`${filepath} does not contain a metrics object`);
  }
  return parsed;
}

function metricValue(manifest, name) {
  const value = Number(manifest.metrics?.[name]);
  return Number.isFinite(value) ? value : null;
}

function percent(ratio) {
  return (ratio * 100).toFixed(1);
}

function compareMetrics(current, baseline) {
  const warnings = [];
  const failures = [];

  for (const name of METRICS) {
    const base = metricValue(baseline, name);
    const next = metricValue(current, name);
    if (base === null || next === null || base <= 0) continue;
    const ratio = (next - base) / base;
    if (ratio >= FAIL_RATIO) {
      failures.push(`${name} grew by ${percent(ratio)}% (${base} -> ${next})`);
    } else if (ratio >= WARN_RATIO) {
      warnings.push(`${name} grew by ${percent(ratio)}% (${base} -> ${next})`);
    }
  }

  return { warnings, failures };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const currentPath = path.resolve(REPO_ROOT, args.current);
  const baselinePath = path.resolve(REPO_ROOT, args.baseline);
  const current = readManifest(currentPath);
  if (!current) {
    console.error(`Missing current artifact manifest: ${currentPath}`);
    process.exit(1);
  }

  const baseline = readManifest(baselinePath);
  if (!baseline) {
    const message = `No artifact trend baseline found at ${baselinePath}`;
    if (args.allowMissingBaseline) {
      console.log(`WARN ${message}; skipping relative trend gate`);
      return;
    }
    console.error(message);
    process.exit(1);
  }

  const { warnings, failures } = compareMetrics(current, baseline);
  for (const warning of warnings) console.log(`WARN ${warning}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }

  console.log(`Artifact trend check passed (${warnings.length} warning(s))`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  compareMetrics,
  METRICS,
  WARN_RATIO,
  FAIL_RATIO,
};
