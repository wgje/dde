import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];
const scriptPath = path.resolve(process.cwd(), 'scripts/update-test-duration-baseline.cjs');

function writeJson(filepath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(value, null, 2));
}

function createFixtureRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function readBaseline(root: string): Record<string, unknown> {
  const baselinePath = path.join(root, 'scripts', 'test-duration-baseline.json');
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Record<string, unknown>;
}

function runBaselineUpdate(root: string): void {
  execFileSync(process.execPath, [scriptPath], {
    cwd: root,
    stdio: 'pipe',
  });
}

describe('update-test-duration-baseline', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('auto-discovers vitest reports when timing payload does not embed report paths', () => {
    const root = createFixtureRoot('nanoflow-baseline-update-');

    writeJson(path.join(root, 'scripts', 'test-quarantine.json'), { files: [] });
    writeJson(path.join(root, 'test-results', 'vitest-local-all-lanes-shard-all.json'), {
      mode: 'local',
      strategy: 'mod',
      scheduler: 'fifo',
      lanes: [
        {
          laneName: 'lane_node_minimal',
          durationMs: 1200,
          segments: [{ segmentName: 'shared', durationMs: 1200 }],
        },
      ],
    });
    writeJson(path.join(root, 'test-results', 'vitest-reports', 'vitest-report-lane_node_minimal-shared-00.json'), {
      testResults: [
        {
          name: path.join(root, 'src/tests/contracts/config-consistency.contract.spec.ts'),
          startTime: 100,
          endTime: 280,
        },
        {
          name: path.join(root, 'src/tests/contracts/focus-quota-consistency.contract.spec.ts'),
          duration: 90,
        },
      ],
    });

    runBaselineUpdate(root);
    const baseline = readBaseline(root);
    const files = baseline['files'] as Record<string, number>;
    const samples = baseline['samples'] as Record<string, number>;
    const inputs = baseline['inputs'] as Record<string, string[]>;

    expect(files['src/tests/contracts/config-consistency.contract.spec.ts']).toBe(180);
    expect(files['src/tests/contracts/focus-quota-consistency.contract.spec.ts']).toBe(90);
    expect(samples['fileSampleCount']).toBe(2);
    expect(inputs['vitestReportsLoaded']).toContain(
      'test-results/vitest-reports/vitest-report-lane_node_minimal-shared-00.json',
    );
  });

  it('supplements missing file samples from vitest reports without overriding timing payload durations', () => {
    const root = createFixtureRoot('nanoflow-baseline-merge-');

    writeJson(path.join(root, 'scripts', 'test-quarantine.json'), { files: [] });
    writeJson(path.join(root, 'test-results', 'vitest-local-all-lanes-shard-all.json'), {
      mode: 'local',
      strategy: 'mod',
      scheduler: 'fifo',
      files: {
        'src/tests/contracts/config-consistency.contract.spec.ts': 120,
      },
      lanes: [
        {
          laneName: 'lane_node_minimal',
          durationMs: 1000,
          segments: [{ segmentName: 'shared', durationMs: 1000 }],
        },
      ],
    });
    writeJson(path.join(root, 'test-results', 'vitest-reports', 'vitest-report-lane_node_minimal-shared-00.json'), {
      testResults: [
        {
          name: path.join(root, 'src/tests/contracts/config-consistency.contract.spec.ts'),
          duration: 999,
        },
        {
          name: path.join(root, 'src/tests/contracts/incremental-sync-default.contract.spec.ts'),
          duration: 210,
        },
      ],
    });

    runBaselineUpdate(root);
    const baseline = readBaseline(root);
    const files = baseline['files'] as Record<string, number>;
    const samples = baseline['samples'] as Record<string, number>;

    expect(files['src/tests/contracts/config-consistency.contract.spec.ts']).toBe(120);
    expect(files['src/tests/contracts/incremental-sync-default.contract.spec.ts']).toBe(210);
    expect(samples['fileSampleCount']).toBe(2);
  });

  it('ignores stale directory reports when timing payload already points to the current run report', () => {
    const root = createFixtureRoot('nanoflow-baseline-stale-report-');

    writeJson(path.join(root, 'scripts', 'test-quarantine.json'), { files: [] });
    writeJson(path.join(root, 'test-results', 'vitest-local-all-lanes-shard-all.json'), {
      mode: 'local',
      strategy: 'mod',
      scheduler: 'fifo',
      generatedVitestReports: {
        loadedPaths: ['test-results/vitest-reports/vitest-report-current.json'],
        requestedPaths: [],
      },
      lanes: [
        {
          laneName: 'lane_node_minimal',
          durationMs: 900,
          segments: [{ segmentName: 'shared', durationMs: 900 }],
        },
      ],
    });
    writeJson(path.join(root, 'test-results', 'vitest-reports', 'vitest-report-current.json'), {
      testResults: [
        {
          name: path.join(root, 'src/tests/contracts/config-consistency.contract.spec.ts'),
          duration: 120,
        },
      ],
    });
    writeJson(path.join(root, 'test-results', 'vitest-reports', 'vitest-report-stale.json'), {
      testResults: [
        {
          name: path.join(root, 'src/tests/contracts/focus-quota-consistency.contract.spec.ts'),
          duration: 999,
        },
      ],
    });

    runBaselineUpdate(root);
    const baseline = readBaseline(root);
    const files = baseline['files'] as Record<string, number>;
    const inputs = baseline['inputs'] as Record<string, string[]>;

    expect(files['src/tests/contracts/config-consistency.contract.spec.ts']).toBe(120);
    expect(files['src/tests/contracts/focus-quota-consistency.contract.spec.ts']).toBeUndefined();
    expect(inputs['vitestReportsLoaded']).toEqual([
      'test-results/vitest-reports/vitest-report-current.json',
    ]);
  });
});