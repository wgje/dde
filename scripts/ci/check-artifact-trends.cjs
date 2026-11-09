#!/usr/bin/env node
// Compare deployment artifact metrics against the last main baseline.

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_CURRENT = path.join(REPO_ROOT, 'dist', 'browser', 'artifact-manifest.json');
const DEFAULT_BASELINE = path.join(REPO_ROOT, 'docs', 'cloudflare-artifact-baseline.json');
const WARN_RATIO = 0.15;
const FAIL_RATIO = 0.30;
const WARNING_ONLY_METRICS = new Set([
  'fileCount',
  'rootJsCount',
  'ngswAssetCount',
]);

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

class EvidenceError extends Error {}
function evidenceError(side, reason) {
  return new EvidenceError(`artifact-trend-evidence-unavailable side=${side} reason=${reason}`);
}
function identityOf(stat, side) {
  if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || stat.dev === 0n || stat.ino === 0n) {
    throw evidenceError(side, 'identity-unavailable');
  }
  return { dev: stat.dev, ino: stat.ino };
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function readManifest(filepath, side) {
  let initialPath;
  try {
    initialPath = fs.lstatSync(filepath, { bigint: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw evidenceError(side, 'unreadable');
  }
  if (!initialPath.isFile() || initialPath.isSymbolicLink()) throw evidenceError(side, 'not-regular');
  let descriptor, primaryError, result;
  try {
    const canonical = fs.realpathSync.native(filepath);
    descriptor = fs.openSync(filepath, 'r');
    const initialFile = fs.fstatSync(descriptor, { bigint: true });
    const snapshots = [initialPath, initialFile];
    if (initialPath.size > BigInt(Number.MAX_SAFE_INTEGER)) throw evidenceError(side, 'size-invalid');
    const bytes = Buffer.alloc(Number(initialPath.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw evidenceError(side, 'drift');
      offset += count;
    }
    snapshots.push(fs.fstatSync(descriptor, { bigint: true }), fs.lstatSync(filepath, { bigint: true }));
    const identities = snapshots.map((stat) => identityOf(stat, side));
    if (
      snapshots.some((stat) => !stat.isFile() || stat.size !== initialPath.size)
      || identities.some((identity) => !sameIdentity(identity, identities[0]))
    ) {
      throw evidenceError(side, 'drift');
    }
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8')); }
    catch { throw evidenceError(side, 'malformed'); }
    if (!manifest || typeof manifest !== 'object' || !manifest.metrics || typeof manifest.metrics !== 'object') throw evidenceError(side, 'malformed');
    result = { manifest, canonical, identity: identities[0] };
  } catch (error) {
    primaryError = error instanceof EvidenceError ? error : evidenceError(side, 'unreadable');
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); }
    catch { if (!primaryError) primaryError = evidenceError(side, 'unreadable'); }
  }
  if (primaryError) throw primaryError;
  return result;
}

function metricValue(manifest, side, name) {
  const metrics = manifest.metrics;
  const value = metrics?.[name];
  if (
    !Object.prototype.hasOwnProperty.call(metrics, name)
    || typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
  ) {
    throw new Error(
      `Invalid artifact metric ${side}.${name}: expected an own finite nonnegative number`,
    );
  }
  return value;
}

function percent(ratio) {
  return (ratio * 100).toFixed(1);
}

function compareMetrics(current, baseline) {
  const warnings = [];
  const failures = [];

  for (const name of METRICS) {
    const base = metricValue(baseline, 'baseline', name);
    const next = metricValue(current, 'current', name);
    if (base === 0) {
      if (next === 0) continue;
      const message = `${name} grew from zero (${base} -> ${next})`;
      if (WARNING_ONLY_METRICS.has(name)) warnings.push(message);
      else failures.push(message);
      continue;
    }
    const ratio = (next - base) / base;
    if (ratio >= FAIL_RATIO && !WARNING_ONLY_METRICS.has(name)) {
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
  const currentEvidence = readManifest(currentPath, 'current');
  if (!currentEvidence) {
    console.error(evidenceError('current', 'missing').message);
    process.exit(1);
  }

  const baselineEvidence = readManifest(baselinePath, 'baseline');
  if (!baselineEvidence) {
    const message = evidenceError('baseline', 'missing').message;
    if (args.allowMissingBaseline) {
      console.log(`WARN ${message}; skipping relative trend gate`);
      return;
    }
    console.error(message);
    process.exit(1);
  }

  if (currentEvidence.canonical === baselineEvidence.canonical) {
    throw evidenceError('pair', 'same-path');
  }
  if (sameIdentity(currentEvidence.identity, baselineEvidence.identity)) {
    throw evidenceError('pair', 'same-identity');
  }

  const { warnings, failures } = compareMetrics(
    currentEvidence.manifest,
    baselineEvidence.manifest,
  );
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
