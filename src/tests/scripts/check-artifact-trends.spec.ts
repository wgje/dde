import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts', 'ci', 'check-artifact-trends.cjs');
const tempRoots: string[] = [];

function writeManifest(root: string, name: string, metrics: Record<string, number>): string {
  const filepath = path.join(root, name);
  fs.writeFileSync(filepath, JSON.stringify({ schemaVersion: 1, metrics, files: {} }, null, 2));
  return filepath;
}

function runTrendGuard(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
}

describe('check-artifact-trends', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails fast when a deploy artifact metric grows by more than 30 percent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-artifact-trend-'));
    tempRoots.push(root);
    const baseline = writeManifest(root, 'baseline.json', {
      fileCount: 100,
      totalBytes: 100_000,
      rootJsCount: 10,
      headerRuleCount: 20,
      ngswAssetCount: 100,
      gojsFlowChunkBytes: 50_000,
    });
    const current = writeManifest(root, 'current.json', {
      fileCount: 131,
      totalBytes: 100_000,
      rootJsCount: 10,
      headerRuleCount: 20,
      ngswAssetCount: 100,
      gojsFlowChunkBytes: 50_000,
    });

    const result = runTrendGuard([`--baseline=${baseline}`, `--current=${current}`]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fileCount grew by 31.0%');
  });

  it('warns without failing when a deploy artifact metric grows by more than 15 percent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-artifact-trend-'));
    tempRoots.push(root);
    const baseline = writeManifest(root, 'baseline.json', {
      fileCount: 100,
      totalBytes: 100_000,
      rootJsCount: 10,
      headerRuleCount: 20,
      ngswAssetCount: 100,
      gojsFlowChunkBytes: 50_000,
    });
    const current = writeManifest(root, 'current.json', {
      fileCount: 116,
      totalBytes: 100_000,
      rootJsCount: 10,
      headerRuleCount: 20,
      ngswAssetCount: 100,
      gojsFlowChunkBytes: 50_000,
    });

    const result = runTrendGuard([`--baseline=${baseline}`, `--current=${current}`]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WARN fileCount grew by 16.0%');
  });
});
