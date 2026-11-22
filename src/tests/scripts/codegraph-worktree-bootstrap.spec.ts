import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const bootstrapPath = path.join(repoRoot, 'scripts', 'codegraph-worktree-bootstrap.cjs');
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

function createClosureSource(): string {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bootstrap-source-'));
  tempRoots.push(sourceRoot);
  const closure = require(bootstrapPath) as {
    REQUIRED_RUNTIME_CLOSURE: readonly string[];
  };
  for (const relativePath of [
    ...closure.REQUIRED_RUNTIME_CLOSURE,
  ]) {
    const target = path.join(sourceRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// fixture\n', 'utf8');
  }
  return sourceRoot;
}

function runBootstrap(root: string, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [bootstrapPath, '--root', root, ...extraArgs, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('codegraph worktree bootstrap', () => {
  it('fails closed when no source root supplies a missing runtime closure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bootstrap-blocked-'));
    tempRoots.push(root);
    const result = runBootstrap(root, ['--no-generate', '--require-ready']);
    expect(result.status).toBe(78);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('ENVIRONMENT_BLOCKED');
    expect(report.independentTasksMayProceed).toBe(true);
    expect(report.taskImpact).toContain('unrelated tasks may proceed');
    expect(report.blockingReason).toContain('no bootstrap source root');
  }, 15_000);

  it('reports closure READY and generation PENDING when --no-generate skips an absent CURRENT', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bootstrap-pending-'));
    const sourceRoot = createClosureSource();
    tempRoots.push(root);
    const result = runBootstrap(root, ['--source-root', sourceRoot, '--no-generate', '--require-ready']);
    expect(result.status, result.stderr || result.stdout).toBe(78);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('GENERATION_PENDING');
    expect(report.generationState).toBe('PENDING');
    expect(report.blockingReason).toBe('CURRENT_MISSING_WITH_RUNTIME_CLOSURE_READY');
    expect(report.runtimeClosure.missingAfter).toEqual([]);
  }, 15_000);

  it('distinguishes malformed CURRENT from a missing generation selector', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bootstrap-invalid-'));
    const sourceRoot = createClosureSource();
    const currentPath = path.join(root, '.codegraph', 'nanoflow-generations', 'CURRENT.json');
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    tempRoots.push(root);
    fs.writeFileSync(currentPath, '{invalid', 'utf8');
    const result = runBootstrap(root, ['--source-root', sourceRoot, '--no-generate', '--require-ready']);
    expect(result.status, result.stderr || result.stdout).toBe(78);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('GENERATION_PENDING');
    expect(report.generationState).toBe('INVALID');
    expect(report.blockingReason).toBe('CURRENT_INVALID_WITH_RUNTIME_CLOSURE_READY');
  }, 15_000);

  it('requires every production runtime closure path in the repository tree', () => {
    const bootstrap = require(bootstrapPath) as {
      REQUIRED_RUNTIME_CLOSURE: readonly string[];
      OPTIONAL_PROTOTYPE_CLOSURE: readonly string[];
      TEST_CLOSURE: readonly string[];
    };
    const nonProductionClosure = new Set([
      ...bootstrap.OPTIONAL_PROTOTYPE_CLOSURE,
      ...bootstrap.TEST_CLOSURE,
    ]);
    const misplaced = bootstrap.REQUIRED_RUNTIME_CLOSURE.filter(relativePath =>
      nonProductionClosure.has(relativePath));
    const missing = bootstrap.REQUIRED_RUNTIME_CLOSURE.filter(relativePath =>
      !fs.existsSync(path.join(repoRoot, relativePath)));

    expect(misplaced).toEqual([]);
    expect(missing).toEqual([]);
  });
  it('keeps test fixtures out of the required runtime category', () => {
    const bootstrap = require(bootstrapPath) as {
      REQUIRED_RUNTIME_CLOSURE: readonly string[];
      TEST_CLOSURE: readonly string[];
    };
    expect(bootstrap.REQUIRED_RUNTIME_CLOSURE).not.toEqual(expect.arrayContaining([
      'src/tests/fixtures/agent-file-lease-worker.cjs',
      'src/tests/fixtures/codegraph-overlay-resident-worker.fake.cjs',
      'src/tests/scripts/agent-file-lease.spec.ts',
      'src/tests/scripts/codegraph-overlay-resident-worker-prototype.spec.ts',
    ]));
    expect(bootstrap.TEST_CLOSURE).toEqual(expect.arrayContaining([
      'src/tests/fixtures/agent-file-lease-worker.cjs',
      'src/tests/fixtures/codegraph-overlay-resident-worker.fake.cjs',
      'src/tests/scripts/agent-file-lease.spec.ts',
      'src/tests/scripts/codegraph-overlay-resident-worker-prototype.spec.ts',
    ]));
    expect(bootstrap.REQUIRED_RUNTIME_CLOSURE).toEqual(expect.arrayContaining([
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      'scripts/lib/codegraph-overlay-worker-pool.cjs',
    ]));
  });

  it('copies the allow-listed closure and leaves generation pending without claiming readiness', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bootstrap-closure-'));
    const sourceRoot = createClosureSource();
    tempRoots.push(root);
    const result = runBootstrap(root, ['--source-root', sourceRoot, '--no-generate']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.independentTasksMayProceed).toBe(true);
    expect(report.runtimeClosure.copied.some((entry: { path: string }) => entry.path === 'scripts/query-codegraph-nanoflow-overlay.mjs')).toBe(true);
    expect(fs.existsSync(path.join(root, 'scripts/query-codegraph-nanoflow-overlay.mjs'))).toBe(true);
    expect(report.status).toBe('CLOSURE_READY_GENERATION_PENDING');
  }, 15_000);
});
