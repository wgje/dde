import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = path.resolve(process.cwd(), 'scripts', 'perf-no-regression-guard.cjs');
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-perf-no-regression-'));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeStatsFixture(filePath: string): void {
  writeJson(filePath, {
    outputs: {
      'main-TEST.js': {
        bytes: 10 * 1024,
        imports: [
          { kind: 'import-statement', path: 'chunk-shared.js' },
        ],
        inputs: {
          'main.ts': { bytesInOutput: 1024 },
        },
      },
      'polyfills-TEST.js': {
        bytes: 5 * 1024,
        imports: [],
        inputs: {
          'polyfills.ts': { bytesInOutput: 512 },
        },
      },
      'chunk-shared.js': {
        bytes: 15 * 1024,
        imports: [],
        inputs: {
          'src/shared-startup.ts': { bytesInOutput: 512 },
        },
      },
      'chunk-workspace-shell.js': {
        bytes: 100 * 1024,
        imports: [],
        inputs: {
          'src/app/core/shell/workspace-shell.component.ts': { bytesInOutput: 1024 },
        },
      },
    },
  });
}

function runGuard(env: Record<string, string>) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
    encoding: 'utf8',
  });
}

describe('perf-no-regression-guard', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('reports how to generate current metrics when they are missing', () => {
    const root = makeTempRoot();
    const baselinePath = path.join(root, 'baseline.json');
    const currentPath = path.join(root, 'missing-current.json');

    writeJson(baselinePath, {
      metrics: {
        'startup.data_requests': 20,
      },
    });

    const result = runGuard({
      PERF_BASELINE_METRICS_PATH: baselinePath,
      PERF_CURRENT_METRICS_PATH: currentPath,
      PERF_STATS_PATH: path.join(root, 'missing-stats.json'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`missing current: ${currentPath}`);
    expect(result.stderr).toContain('Generate real runtime metrics first: npm run test:e2e:perf');
    expect(result.stderr).toContain('Required env: E2E_PERF_EMAIL and E2E_PERF_PASSWORD');
    expect(result.stderr).toContain('do not fabricate current-metrics.json');
  });

  it('passes when runtime metrics and build stats are within baseline', () => {
    const root = makeTempRoot();
    const baselinePath = path.join(root, 'baseline.json');
    const currentPath = path.join(root, 'current.json');
    const statsPath = path.join(root, 'stats.json');

    writeJson(baselinePath, {
      metrics: {
        'startup.data_requests': 20,
        'build.initial_static_kb': 30,
        'build.workspace_chunk_kb': 100,
        'build.main_static_imports': 1,
      },
    });
    writeJson(currentPath, {
      metrics: {
        'startup.data_requests': 18,
        'resume.heavy_record_count': 1,
        'resume.heavy_ticket_count': 1,
      },
    });
    writeStatsFixture(statsPath);

    const result = runGuard({
      PERF_BASELINE_METRICS_PATH: baselinePath,
      PERF_CURRENT_METRICS_PATH: currentPath,
      PERF_STATS_PATH: statsPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[perf-no-regression-guard] OK');
    expect(result.stdout).toContain('build.workspace_chunk_kb: 100.00 (baseline 100.00)');
  });

  it('fails when a current metric exceeds the regression budget', () => {
    const root = makeTempRoot();
    const baselinePath = path.join(root, 'baseline.json');
    const currentPath = path.join(root, 'current.json');

    writeJson(baselinePath, {
      metrics: {
        'startup.data_requests': 10,
      },
    });
    writeJson(currentPath, {
      metrics: {
        'startup.data_requests': 12,
        'resume.heavy_record_count': 1,
        'resume.heavy_ticket_count': 1,
      },
    });

    const result = runGuard({
      PERF_BASELINE_METRICS_PATH: baselinePath,
      PERF_CURRENT_METRICS_PATH: currentPath,
      PERF_STATS_PATH: path.join(root, 'missing-stats.json'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[perf-no-regression-guard] regressions detected:');
    expect(result.stderr).toContain('startup.data_requests: regression 12.00 > allowed 10.50');
  });
});
