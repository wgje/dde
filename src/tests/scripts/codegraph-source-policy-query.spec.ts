import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  publishOverlayFixture,
  type PublishedOverlayFixture,
} from './codegraph-overlay-generation-test-helpers';

const repoRoot = path.resolve(__dirname, '../../..');
const queryPath = path.join(repoRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
const sourcePolicyDigest = 'ca78ea5e17d32399faac676bcab26fc1d7f48186a89792774d37a6b8549d0ca3';
const fixtures: PublishedOverlayFixture[] = [];

function fixture(): PublishedOverlayFixture {
  const created = publishOverlayFixture('source-policy-probe');
  fixtures.push(created);
  return created;
}

function runQuery(root: string) {
  return spawnSync(process.execPath, [
    queryPath,
    '--root', root,
    '--query', 'source-policy-probe',
    '--json',
    '--skip-refresh',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup();
});

describe('NanoFlow SourcePolicy query publication binding', { timeout: 30_000 }, () => {
  it('delegates payload and SourcePolicy authentication exclusively to the shared reader', () => {
    const source = fs.readFileSync(queryPath, 'utf8');
    expect(source).toContain("import currentReceiptReader from './lib/codegraph-overlay-current-receipt.cjs';");
    expect(source).not.toContain("import sourcePolicy from './lib/codegraph-source-policy.cjs';");
    expect(source).not.toContain('hasNewerOverlayRelevantFile');
    expect(source).not.toContain('ensureOverlay');
  });

  it('queries an immutable published generation and treats --skip-refresh as a no-op', () => {
    const created = fixture();
    fs.mkdirSync(path.join(created.root, 'src', 'app'), { recursive: true });
    fs.writeFileSync(path.join(created.root, 'src', 'app', 'newer-source.ts'), 'export const newer = true;\n');

    const result = runQuery(created.root);

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ query: 'source-policy-probe' });
    expect(created.publication.current.sourcePolicyDigest).toBe(sourcePolicyDigest);
  });

  it('fails closed when CURRENT widens the released SourcePolicy digest', () => {
    const created = fixture();
    const currentPath = path.join(
      created.root,
      '.codegraph',
      'nanoflow-generations',
      'CURRENT.json',
    );
    const current = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as Record<string, unknown>;
    current.sourcePolicyDigest = '0'.repeat(64);
    const canonical = Object.fromEntries(Object.keys(current).sort().map(key => [key, current[key]]));
    fs.writeFileSync(currentPath, `${JSON.stringify(canonical)}\n`);

    const result = runQuery(created.root);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('overlay-current-current-invalid\n');
  });
});
