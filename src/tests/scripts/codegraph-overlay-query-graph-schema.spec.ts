import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  publishOverlayFixture,
  type PublishedOverlayFixture,
} from './codegraph-overlay-generation-test-helpers';

const repoRoot = path.resolve(__dirname, '../../..');
const queryPath = path.join(repoRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
const fixtures: PublishedOverlayFixture[] = [];

function fixture(name = 'example'): PublishedOverlayFixture {
  const created = publishOverlayFixture(name);
  fixtures.push(created);
  return created;
}

function runQuery(root: string, extra: string[] = []): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [
    queryPath,
    '--root', root,
    '--query', 'example',
    '--context-json',
    ...extra,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

function descriptorPath(created: PublishedOverlayFixture, jsonPath: string[]): string {
  const arrays = created.publication.manifest.arrays as Array<{
    jsonPath: string[];
    shards: Array<{ path: string }>;
  }>;
  const descriptor = arrays.find(entry => JSON.stringify(entry.jsonPath) === JSON.stringify(jsonPath));
  if (!descriptor?.shards[0]) throw new Error(`missing fixture descriptor ${jsonPath.join('.')}`);
  return path.join(created.publication.generationPath, descriptor.shards[0].path);
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup();
});

describe('CodeGraph overlay query graph schema', { timeout: 30_000 }, () => {
  it('queries authenticated nodes without mutating the selected generation', () => {
    const created = fixture();
    const currentPath = path.join(
      created.root,
      '.codegraph',
      'nanoflow-generations',
      'CURRENT.json',
    );
    const before = fs.readFileSync(currentPath);

    const result = runQuery(created.root);

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ query: 'example', count: 1 });
    expect(fs.readFileSync(currentPath).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(created.root, '.codegraph', 'nanoflow-overlay.json'))).toBe(false);
  });

  it('fails closed on authenticated graph shard drift without regeneration or partial output', () => {
    const created = fixture();
    const canary = 'private-graph-shard-canary';
    fs.appendFileSync(descriptorPath(created, ['graph', 'nodes']), `${JSON.stringify({ canary })}\n`);

    const result = runQuery(created.root);

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('overlay-current-payload-invalid\n');
    expect(result.stderr).not.toContain(canary);
    expect(fs.existsSync(path.join(created.root, '.codegraph', 'nanoflow-overlay.json'))).toBe(false);
  });

  it('rejects legacy raw overlay selection before reading an otherwise valid generation', () => {
    const created = fixture();
    const rawPath = path.join(created.root, 'legacy.json');
    fs.writeFileSync(rawPath, '{"canary":"legacy-raw-authority"}\n');

    const result = runQuery(created.root, ['--overlay', 'legacy.json']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--overlay is no longer supported');
    expect(result.stderr).not.toContain('legacy-raw-authority');
  });

  it('fails closed for a noncanonical CURRENT selector', () => {
    const created = fixture();
    const currentPath = path.join(
      created.root,
      '.codegraph',
      'nanoflow-generations',
      'CURRENT.json',
    );
    fs.appendFileSync(currentPath, ' ');

    const result = runQuery(created.root);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('overlay-current-current-invalid\n');
  });
});
