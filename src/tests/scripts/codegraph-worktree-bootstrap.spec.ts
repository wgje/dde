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

describe('codegraph worktree bootstrap', () => {
  it('classifies a missing CURRENT as environment blocked without turning it into task failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bootstrap-blocked-'));
    tempRoots.push(root);
    const result = spawnSync(process.execPath, [bootstrapPath, '--root', root, '--no-generate', '--require-ready', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(78);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('ENVIRONMENT_BLOCKED');
    expect(report.independentTasksMayProceed).toBe(true);
    expect(report.taskImpact).toContain('unrelated tasks may proceed');
    expect(report.blockingReason).toMatch(/runtime dependency closure|CURRENT\\.json/);
  });

  it('copies only the allow-listed missing closure and remains non-blocking by default', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bootstrap-closure-'));
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bootstrap-source-'));
    tempRoots.push(root, sourceRoot);
    const sourceRelative = 'scripts/lib/codegraph-overlay-generation-cache.cjs';
    fs.mkdirSync(path.join(sourceRoot, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, sourceRelative), 'module.exports = { fixture: true };\n', 'utf8');
    const result = spawnSync(process.execPath, [
      bootstrapPath, '--root', root, '--source-root', sourceRoot, '--no-generate', '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.independentTasksMayProceed).toBe(true);
    expect(report.runtimeClosure.copied.some((entry: { path: string }) => entry.path === sourceRelative)).toBe(true);
    expect(fs.existsSync(path.join(root, sourceRelative))).toBe(true);
    expect(report.status).toBe('ENVIRONMENT_BLOCKED');
  });
});
