import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts', 'ci', 'check-artifact-trends.cjs');
const tempRoots: string[] = [];
const require = createRequire(import.meta.url);
const { compareMetrics, METRICS } = require(scriptPath) as {
  compareMetrics: (
    current: { metrics: Record<string, unknown> },
    baseline: { metrics: Record<string, unknown> },
  ) => { warnings: string[]; failures: string[] };
  METRICS: string[];
};
function validMetrics(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fileCount: 100,
    totalBytes: 100_000,
    rootJsCount: 10,
    headerRuleCount: 20,
    ngswAssetCount: 100,
    gojsFlowChunkBytes: 50_000,
    ...overrides,
  };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-artifact-trend-'));
  tempRoots.push(root);
  return root;
}
function writeManifest(root: string, name: string, metrics: Record<string, unknown>): string {
  const filepath = path.join(root, name);
  fs.writeFileSync(filepath, JSON.stringify({ schemaVersion: 1, metrics, files: {} }, null, 2));
  return filepath;
}

function runTrendGuard(args: string[], preloadPath?: string) {
  const nodeArgs = preloadPath ? ['--require', preloadPath] : [];
  return spawnSync(process.execPath, [...nodeArgs, scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
}

function expectEvidenceFailure(
  current: string,
  baseline: string,
  side: 'current' | 'baseline' | 'pair',
  reason: string,
  options: { allowMissing?: boolean; preload?: string } = {},
): void {
  const args = [`--baseline=${baseline}`, `--current=${current}`];
  if (options.allowMissing) args.push('--allow-missing-baseline');
  const result = runTrendGuard(args, options.preload);
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('Artifact trend check passed');
  expect(result.stderr.trim()).toBe(
    `artifact-trend-evidence-unavailable side=${side} reason=${reason}`,
  );
}

describe('check-artifact-trends', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails fast when a byte-sized deploy artifact metric grows by more than 30 percent', () => {
    const root = tempRoot();
    const baseline = writeManifest(root, 'baseline.json', validMetrics());
    const current = writeManifest(root, 'current.json', validMetrics({ totalBytes: 131_000 }));
    const result = runTrendGuard([`--baseline=${baseline}`, `--current=${current}`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('totalBytes grew by 31.0%');
  });

  it('warns without failing when count-only metrics grow after lazy chunk splitting', () => {
    const root = tempRoot();
    const baseline = writeManifest(root, 'baseline.json', validMetrics());
    const current = writeManifest(root, 'current.json', validMetrics({
      fileCount: 160,
      rootJsCount: 18,
      ngswAssetCount: 160,
    }));
    const result = runTrendGuard([`--baseline=${baseline}`, `--current=${current}`]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WARN fileCount grew by 60.0%');
    expect(result.stdout).toContain('WARN rootJsCount grew by 80.0%');
    expect(result.stdout).toContain('WARN ngswAssetCount grew by 60.0%');
  });

  it('warns without failing when a deploy artifact metric grows by more than 15 percent', () => {
    const root = tempRoot();
    const baseline = writeManifest(root, 'baseline.json', validMetrics());
    const current = writeManifest(root, 'current.json', validMetrics({ fileCount: 116 }));
    const result = runTrendGuard([`--baseline=${baseline}`, `--current=${current}`]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WARN fileCount grew by 16.0%');
  });

  it.each([
    ['null', null],
    ['string', '100000'],
    ['negative', -1],
  ])('fails closed when the current totalBytes metric is %s', (_label, value) => {
    const root = tempRoot();
    const baseline = writeManifest(root, 'baseline.json', validMetrics());
    const current = writeManifest(root, 'current.json', validMetrics({ totalBytes: value }));
    const result = runTrendGuard([`--baseline=${baseline}`, `--current=${current}`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Invalid artifact metric current.totalBytes: expected an own finite nonnegative number',
    );
  });

  it.each(METRICS.flatMap((name) => [
    ['current', name],
    ['baseline', name],
  ]))('fails closed when %s.%s is missing', (side, name) => {
    const root = tempRoot();
    const currentMetrics = validMetrics();
    const baselineMetrics = validMetrics();
    delete (side === 'current' ? currentMetrics : baselineMetrics)[name];
    const baseline = writeManifest(root, 'baseline.json', baselineMetrics);
    const current = writeManifest(root, 'current.json', currentMetrics);
    const result = runTrendGuard([`--baseline=${baseline}`, `--current=${current}`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Invalid artifact metric ${side}.${name}: expected an own finite nonnegative number`,
    );
  });

  it('only skips a genuinely missing baseline with the flag', () => {
    const root = tempRoot();
    const current = writeManifest(root, 'current.json', validMetrics());
    const baseline = path.join(root, 'missing.json');
    expect(runTrendGuard([`--baseline=${baseline}`, `--current=${current}`, '--allow-missing-baseline']).status).toBe(0);
    const denied = runTrendGuard([`--baseline=${baseline}`, `--current=${current}`]);
    expect(denied.status).toBe(1);
    expect(denied.stderr.trim()).toBe('artifact-trend-evidence-unavailable side=baseline reason=missing');
  });
  it('does not let allow-missing-baseline accept an invalid present baseline', () => {
    const root = tempRoot();
    const baselineMetrics = validMetrics();
    delete baselineMetrics.totalBytes;
    const baseline = writeManifest(root, 'baseline.json', baselineMetrics);
    const current = writeManifest(root, 'current.json', validMetrics());

    const result = runTrendGuard([
      `--baseline=${baseline}`,
      `--current=${current}`,
      '--allow-missing-baseline',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Invalid artifact metric baseline.totalBytes: expected an own finite nonnegative number',
    );
  });

  it.each(['current', 'baseline'])('rejects an inherited %s allowlisted metric with exit 1', (side) => {
    const root = tempRoot();
    const currentMetrics = validMetrics();
    const baselineMetrics = validMetrics();
    delete (side === 'current' ? currentMetrics : baselineMetrics).totalBytes;
    const baseline = writeManifest(root, 'baseline.json', baselineMetrics);
    const current = writeManifest(root, 'current.json', currentMetrics);
    const preloadPath = path.join(root, 'inherited-metric.cjs');
    fs.writeFileSync(preloadPath, 'Object.prototype.totalBytes = 100000;\n');
    const result = runTrendGuard(
      [`--baseline=${baseline}`, `--current=${current}`],
      preloadPath,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Invalid artifact metric ${side}.totalBytes: expected an own finite nonnegative number`,
    );
  });

  it('passes unchanged zero metrics and ignores extra metrics', () => {
    const result = compareMetrics(
      { metrics: validMetrics({ headerRuleCount: 0, futureMetric: 'ignored' }) },
      { metrics: validMetrics({ headerRuleCount: 0 }) },
    );
    expect(result).toEqual({ warnings: [], failures: [] });
  });

  it('warns when a warning-only metric grows from zero', () => {
    const result = compareMetrics(
      { metrics: validMetrics({ fileCount: 1 }) },
      { metrics: validMetrics({ fileCount: 0 }) },
    );
    expect(result).toEqual({
      warnings: ['fileCount grew from zero (0 -> 1)'],
      failures: [],
    });
  });

  it.each(['totalBytes', 'headerRuleCount', 'gojsFlowChunkBytes'])(
    'fails when protected metric %s grows from zero',
    (name) => {
      const result = compareMetrics(
        { metrics: validMetrics({ [name]: 1 }) },
        { metrics: validMetrics({ [name]: 0 }) },
      );
      expect(result).toEqual({
        warnings: [],
        failures: [`${name} grew from zero (0 -> 1)`],
      });
    },
  );

  it('rejects the same path and hardlink evidence', () => {
    const root = tempRoot();
    const current = writeManifest(root, 'current.json', validMetrics());
    expectEvidenceFailure(current, current, 'pair', 'same-path');
    const baseline = path.join(root, 'baseline.json');
    fs.linkSync(current, baseline);
    expectEvidenceFailure(current, baseline, 'pair', 'same-identity');
  });

  it('accepts distinct identities with equal bytes', () => {
    const root = tempRoot();
    const current = writeManifest(root, 'current.json', validMetrics());
    const baseline = writeManifest(root, 'baseline.json', validMetrics());
    expect(runTrendGuard([`--baseline=${baseline}`, `--current=${current}`]).status).toBe(0);
  });

  it.each(['file', 'junction'] as const)('rejects a supported %s link alias', (kind) => {
    const root = tempRoot();
    const targetRoot = path.join(root, 'target');
    fs.mkdirSync(targetRoot);
    const current = writeManifest(targetRoot, 'manifest.json', validMetrics());
    const aliasRoot = kind === 'junction' ? path.join(root, 'alias') : targetRoot;
    const baseline = kind === 'junction'
      ? path.join(aliasRoot, 'manifest.json')
      : path.join(root, 'alias.json');
    try {
      fs.symlinkSync(kind === 'junction' ? targetRoot : current, kind === 'junction' ? aliasRoot : baseline, kind);
    } catch {
      return;
    }
    expectEvidenceFailure(current, baseline, kind === 'file' ? 'baseline' : 'pair', kind === 'file' ? 'not-regular' : 'same-path');
  });

  it('fails closed on observable descriptor drift', () => {
    const root = tempRoot();
    const current = writeManifest(root, 'current.json', validMetrics());
    const baseline = writeManifest(root, 'baseline.json', validMetrics());
    const preload = path.join(root, 'drift-secret.cjs');
    fs.writeFileSync(preload, "const fs=require('node:fs');const real=fs.fstatSync;let n=0;fs.fstatSync=(fd,o)=>{const s=real(fd,o);if(++n===2)Object.defineProperty(s,'size',{value:s.size+1n});return s};\n");
    expectEvidenceFailure(current, baseline, 'current', 'drift', { preload });
  });

  it.each(['dangling', 'directory', 'unreadable', 'malformed'] as const)(
    'rejects a present %s baseline when missing is allowed',
    (kind) => {
      const root = tempRoot();
      const current = writeManifest(root, 'current.json', validMetrics());
      const baseline = path.join(root, 'baseline.json');
      let preload: string | undefined;
      if (kind === 'dangling') fs.symlinkSync(path.join(root, 'absent.json'), baseline, 'file');
      else if (kind === 'directory') fs.mkdirSync(baseline);
      else if (kind === 'malformed') fs.writeFileSync(baseline, '{secret-json');
      else {
        fs.writeFileSync(baseline, '{}');
        preload = path.join(root, 'read-secret.cjs');
        fs.writeFileSync(preload, "const fs=require('node:fs');const real=fs.openSync;fs.openSync=(p,...a)=>String(p).endsWith('baseline.json')?(()=>{throw Error('secret-path')})():real(p,...a);\n");
      }
      const reason = kind === 'malformed' ? 'malformed' : kind === 'unreadable' ? 'unreadable' : 'not-regular';
      expectEvidenceFailure(current, baseline, 'baseline', reason, { allowMissing: true, preload });
    },
  );
});
