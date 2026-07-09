import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const preflightScriptPath = path.join(projectRoot, 'scripts', 'codegraph-adapter-preflight.cjs');
const tempRoots: string[] = [];
const PREFLIGHT_TEST_TIMEOUT_MS = 10_000;

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-preflight-'));
  tempRoots.push(root);
  return root;
}

function seedRoot(root: string): void {
  mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        'codegraph:adapter:gate': 'node scripts/run-codegraph-adapter-gate.cjs',
        'codegraph:adapter:quick-gate': 'node scripts/run-codegraph-adapter-gate.cjs --profile quick',
        'codegraph:adapter:doctor': 'node scripts/codegraph-adapter-doctor.cjs',
        'codegraph:adapter:preflight': 'node scripts/codegraph-adapter-preflight.cjs',
        'codegraph:overlay:validate': 'npm run codegraph:overlay && npm run codegraph:overlay:docs:validate',
        'codegraph:overlay:baseline:manifest': 'node scripts/generate-codegraph-overlay-baseline-manifest.cjs',
        'agent:file-lease': 'node scripts/agent-file-lease.cjs',
      },
    }),
  );
  writeFileSync(
    path.join(root, '.codegraph', 'nanoflow-overlay.json'),
    JSON.stringify({ graph: { nodes: [], edges: [] } }),
  );
  writeFileSync(path.join(root, 'tmp', 'agent-file-leases.json'), JSON.stringify({ leases: {} }));
}

function runPreflight(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [preflightScriptPath, '--root', root, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

function runGit(root: string, args: string[]) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });
}

function initGit(root: string): void {
  expect(runGit(root, ['init']).status).toBe(0);
  expect(runGit(root, ['config', 'user.email', 'preflight@example.invalid']).status).toBe(0);
  expect(runGit(root, ['config', 'user.name', 'Preflight Test']).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), 'tmp/\n');
  expect(runGit(root, ['add', '.gitignore']).status).toBe(0);
  expect(runGit(root, ['commit', '-m', 'seed']).status).toBe(0);
}

describe('codegraph-adapter-preflight', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }, PREFLIGHT_TEST_TIMEOUT_MS);

  it('prints a machine-readable shared-tree preflight report', () => {
    const root = makeRoot();
    seedRoot(root);

    const result = runPreflight(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'git:status', ok: true }),
      expect.objectContaining({ name: 'doctor', ok: true }),
      expect.objectContaining({ name: 'lease:status', ok: true }),
    ]));
    expect(report.git).toEqual(expect.objectContaining({
      statusShort: expect.any(String),
      diffNameOnly: expect.any(String),
    }));
  }, PREFLIGHT_TEST_TIMEOUT_MS);

  it('can claim target files as part of preflight', () => {
    const root = makeRoot();
    seedRoot(root);

    const result = runPreflight(root, ['--owner', 'agent-a', '--claim', 'AGENTS.md']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.claim).toEqual(expect.objectContaining({
      ok: true,
      claimed: ['AGENTS.md'],
    }));
  });

  it('reports dirty target files before claiming them', () => {
    const root = makeRoot();
    seedRoot(root);
    initGit(root);
    writeFileSync(path.join(root, 'AGENTS.md'), 'changed docs\n');

    const result = runPreflight(root, ['--owner', 'agent-a', '--claim', 'AGENTS.md']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.targetFiles).toEqual(expect.objectContaining({
      files: ['AGENTS.md'],
      dirtyFiles: ['AGENTS.md'],
    }));
    expect(report.targetFiles.details).toContainEqual(expect.objectContaining({
      file: 'AGENTS.md',
      dirty: true,
      leased: false,
      leaseConflict: false,
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'target-files:dirty',
        ok: true,
        dirtyFiles: ['AGENTS.md'],
      }),
    ]));
    expect(report.claim).toEqual(expect.objectContaining({
      ok: true,
      claimed: ['AGENTS.md'],
    }));
  }, PREFLIGHT_TEST_TIMEOUT_MS);

  it('blocks claiming files leased by another owner and reports the conflict', () => {
    const root = makeRoot();
    seedRoot(root);
    writeFileSync(
      path.join(root, 'tmp', 'agent-file-leases.json'),
      JSON.stringify({
        leases: {
          'AGENTS.md': {
            owner: 'agent-b',
            claimedAt: '2026-06-18T00:00:00.000Z',
            expiresAt: '2999-01-01T00:00:00.000Z',
            expiresAtMs: 32472144000000,
          },
        },
      }),
    );

    const result = runPreflight(root, ['--owner', 'agent-a', '--claim', 'AGENTS.md']);

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.targetFiles.leaseConflicts).toEqual([
      expect.objectContaining({
        file: 'AGENTS.md',
        owner: 'agent-b',
      }),
    ]);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'target-files:lease-conflicts',
        ok: false,
      }),
    ]));
    expect(report.claim).toBeUndefined();
  }, PREFLIGHT_TEST_TIMEOUT_MS);
});
