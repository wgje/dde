import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const matrixScript = path.join(process.cwd(), 'scripts', 'run-test-matrix.cjs');
const fixtureRoots: string[] = [];
const matrixControlEnvKeys = [
  'TEST_BASELINE_MAX_AGE_HOURS',
  'TEST_DURATION_BASELINE',
  'TEST_INCLUDE_QUARANTINE',
  'TEST_LANE_OVERRIDES',
  'TEST_LPT_REQUIRE_FRESH_BASELINE',
  'TEST_LPT_SCHEDULER',
  'TEST_MAX_PROCS',
  'TEST_MIN_FILE_ESTIMATES',
  'TEST_MODE',
  'TEST_QUARANTINE_FILE',
  'TEST_SHARD_INDEX',
  'TEST_SHARD_STRATEGY',
  'TEST_SHARDS',
  'TEST_TIMING_FILE',
  'TEST_TIMING_IN',
  'TEST_VITEST_JSON_OUT_DIR',
] as const;

function createFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-test-matrix-empty-'));
  fixtureRoots.push(root);

  const specPath = path.join(root, 'src', 'services', 'fixture.service.spec.ts');
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(
    specPath,
    [
      "import { TestBed } from '@angular/core/testing';",
      "describe('fixture', () => {",
      '  void TestBed;',
      '});',
      '',
    ].join('\n'),
  );

  return root;
}

function runMatrix(root: string, lanes: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    NANOFLOW_TEST_MATRIX_VITEST_TIMEOUT_MS: '5000',
  };
  for (const key of matrixControlEnvKeys) {
    delete env[key];
  }

  return spawnSync(
    process.execPath,
    [matrixScript, `--lane=${lanes}`, '--max-procs=1'],
    {
      cwd: root,
      encoding: 'utf8',
      env,
      timeout: 10_000,
      windowsHide: true,
    },
  );
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('run-test-matrix aggregate selection contract', () => {
  it('fails closed when selected lanes produce zero execution tasks', () => {
    const root = createFixtureRoot();

    const result = runMatrix(root, 'lane_node_minimal');

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'selectedLanes=lane_node_minimal taskCount=0',
    );
  });

  it('allows an empty selected lane when the aggregate task set is nonempty', () => {
    const root = createFixtureRoot();
    const markerPath = path.join(root, 'vitest-invocation.json');
    const vitestPath = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
    fs.mkdirSync(path.dirname(vitestPath), { recursive: true });
    fs.writeFileSync(
      vitestPath,
      [
        "import fs from 'node:fs';",
        'fs.writeFileSync(',
        '  process.env.NANOFLOW_TEST_MATRIX_STUB_MARKER,',
        '  JSON.stringify(process.argv.slice(2)),',
        ');',
        '',
      ].join('\n'),
    );

    const result = runMatrix(
      root,
      'lane_node_minimal,lane_testbed_service',
      { NANOFLOW_TEST_MATRIX_STUB_MARKER: markerPath },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(fs.existsSync(markerPath)).toBe(true);
    const invocation = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as string[];
    expect(invocation).toContain('src/services/fixture.service.spec.ts');
  });
});
