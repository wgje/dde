import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const leaseScriptPath = path.join(projectRoot, 'scripts', 'agent-file-lease.cjs');
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-agent-file-lease-'));
  tempRoots.push(root);
  return root;
}

function runLease(root: string, args: string[]) {
  return spawnSync(process.execPath, [leaseScriptPath, '--root', root, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

describe('agent-file-lease', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('claims, reports, and releases machine-readable file leases', () => {
    const root = makeRoot();

    const claim = runLease(root, ['claim', '--owner', 'agent-a', 'AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']);

    expect(claim.status, claim.stderr || claim.stdout).toBe(0);
    const claimed = JSON.parse(claim.stdout);
    expect(claimed.ok).toBe(true);
    expect(claimed.claimed).toEqual(['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']);

    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    expect(existsSync(leasePath)).toBe(true);
    const leaseFile = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(leaseFile.leases['AGENTS.md'].owner).toBe('agent-a');

    const status = runLease(root, ['status']);
    expect(status.status, status.stderr || status.stdout).toBe(0);
    expect(JSON.parse(status.stdout).leases['AGENTS.md'].owner).toBe('agent-a');

    const release = runLease(root, ['release', '--owner', 'agent-a', 'AGENTS.md']);
    expect(release.status, release.stderr || release.stdout).toBe(0);
    expect(JSON.parse(release.stdout).released).toEqual(['AGENTS.md']);
  });

  it('rejects conflicting claims unless the same owner refreshes the lease', () => {
    const root = makeRoot();

    expect(runLease(root, ['claim', '--owner', 'agent-a', 'AGENTS.md']).status).toBe(0);

    const conflict = runLease(root, ['claim', '--owner', 'agent-b', 'AGENTS.md']);
    expect(conflict.status).toBe(1);
    expect(JSON.parse(conflict.stdout).conflicts).toEqual([
      expect.objectContaining({
        file: 'AGENTS.md',
        owner: 'agent-a',
      }),
    ]);

    const refresh = runLease(root, ['claim', '--owner', 'agent-a', 'AGENTS.md']);
    expect(refresh.status, refresh.stderr || refresh.stdout).toBe(0);
    expect(JSON.parse(refresh.stdout).claimed).toEqual(['AGENTS.md']);
  });

  it('uses an atomic lock file and removes stale lock leftovers', () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');

    const claim = runLease(root, ['claim', '--owner', 'agent-a', 'AGENTS.md']);

    expect(claim.status, claim.stderr || claim.stdout).toBe(0);
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, JSON.stringify({
      pid: 999999,
      owner: 'dead-agent',
      createdAtMs: Date.now() - 10 * 60 * 1000,
    }));

    const status = runLease(root, ['status']);

    expect(status.status, status.stderr || status.stdout).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('keeps status read-only and prunes only through an explicit command', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');

    const missingStatus = runLease(root, ['status']);
    expect(missingStatus.status, missingStatus.stderr || missingStatus.stdout).toBe(0);
    expect(existsSync(leasePath)).toBe(false);

    expect(runLease(root, ['claim', '--owner', 'agent-a', '--ttl-ms', '1', 'AGENTS.md']).status).toBe(0);
    const beforeStatusMtime = statSync(leasePath).mtimeMs;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);

    const status = runLease(root, ['status']);
    expect(status.status, status.stderr || status.stdout).toBe(0);
    const report = JSON.parse(status.stdout);
    expect(report.leases).toEqual({});
    expect(report.expired).toEqual(expect.objectContaining({
      'AGENTS.md': expect.objectContaining({ owner: 'agent-a' }),
    }));
    expect(statSync(leasePath).mtimeMs).toBe(beforeStatusMtime);

    const prune = runLease(root, ['prune']);
    expect(prune.status, prune.stderr || prune.stdout).toBe(0);
    expect(JSON.parse(readFileSync(leasePath, 'utf8')).leases).toEqual({});
  });
});
