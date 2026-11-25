import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const leaseCli = path.join(repoRoot, 'scripts', 'agent-file-lease.cjs');
const roots: string[] = [];

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-file-lease-dead-barrier-'));
  roots.push(root);
  return root;
}

function runLease(root: string, args: string[], input?: string) {
  return spawnSync(process.execPath, [leaseCli, '--root', root, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
  });
}

function jsonResult(result: ReturnType<typeof runLease>) {
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

describe('agent-file-lease stale overlay publication barrier recovery', () => {
  it('recovers an explicitly confirmed abandoned WAITING barrier only after leases drain and heartbeat is stale', () => {
    const root = makeRoot();
    const owner = 'nanoflow-prod-recovery-baseline';
    const writer = jsonResult(runLease(root, ['--owner', 'writer-a', 'claim', 'held.ts']));
    expect(writer.ok).toBe(true);
    const token = crypto.randomBytes(32).toString('hex');
    const acquired = jsonResult(runLease(root, ['--owner', owner, '--barrier-token', token, 'barrier-acquire']));
    expect(acquired.barrier.state).toBe('WAITING');

    const confirmation = ['--owner', owner, '--confirm-abandoned-barrier-owner', owner, 'barrier-recover-abandoned-wait'];
    const fresh = jsonResult(runLease(root, confirmation));
    expect(fresh).toEqual(expect.objectContaining({ ok: false, reason: 'barrier-not-stale' }));

    const registryPath = path.join(root, 'tmp', 'agent-file-leases.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { barrier: { acquiredAt: string; heartbeatAt: string; transitions: Array<{ at: string }> } };
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    registry.barrier.acquiredAt = staleAt;
    registry.barrier.heartbeatAt = staleAt;
    for (const transition of registry.barrier.transitions) transition.at = staleAt;
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const blocked = jsonResult(runLease(root, confirmation));
    expect(blocked).toEqual(expect.objectContaining({ ok: false, reason: 'active-file-leases' }));

    expect(jsonResult(runLease(root, ['--owner', 'writer-a', 'release', 'held.ts'])).released).toEqual(['held.ts']);
    const recovered = jsonResult(runLease(root, confirmation));
    expect(recovered).toEqual(expect.objectContaining({
      ok: true,
      command: 'barrier-recover-abandoned-wait',
      recovered: true,
      barrier: expect.objectContaining({ state: 'RELEASED', owner }),
    }));
    expect(recovered.barrier.fence).toBeNull();
  }, 15_000);

  it('rejects abandoned-WAITING recovery unless the caller confirms the exact barrier owner', () => {
    const root = makeRoot();
    const owner = 'nanoflow-prod-recovery-baseline';
    const token = crypto.randomBytes(32).toString('hex');
    const acquired = jsonResult(runLease(root, ['--owner', owner, '--barrier-token', token, 'barrier-acquire']));
    expect(acquired.barrier.state).toBe('HELD');
    const denied = jsonResult(runLease(root, [
      '--owner', owner,
      '--confirm-abandoned-barrier-owner', 'different-owner',
      'barrier-recover-abandoned-wait',
    ]));
    expect(denied).toEqual(expect.objectContaining({ ok: false, reason: 'abandoned-barrier-confirmation-mismatch' }));
  }, 15_000);

  it('recovers only an abandoned overlay-generator barrier and its bound build lease', () => {
    const root = makeRoot();
    const deadOwnerProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(deadOwnerProcess.pid).toBeGreaterThan(0);
    const owner = 'codegraph-overlay-generator:' + deadOwnerProcess.pid;
    const token = crypto.randomBytes(32).toString('hex');
    const acquired = jsonResult(runLease(root, ['--owner', owner, '--barrier-token', token, 'barrier-acquire']));
    expect(acquired.ok).toBe(true);
    expect(acquired.barrier.state).toBe('HELD');

    const resource = jsonResult(runLease(root, [
      '--owner', owner,
      '--ttl-ms', '3600000',
      '--resource-kind', 'build',
      '--resource-id', 'codegraph-overlay-generation',
      '--resource-token-stdin',
      'resource-lease-acquire',
    ], token));
    expect(resource.ok).toBe(true);
    expect(resource.acquired).toBe(true);

    const recovered = jsonResult(runLease(root, ['--owner', owner, 'barrier-recover-stale']));
    expect(recovered).toEqual(expect.objectContaining({
      ok: true,
      command: 'barrier-recover-stale',
      recovered: true,
      ownerPid: deadOwnerProcess.pid,
      releasedResourceLeaseCount: 1,
      barrier: expect.objectContaining({ state: 'RELEASED', owner }),
    }));
    const status = jsonResult(runLease(root, ['--owner', owner, 'status']));
    expect(status.resourceLeases.active).toEqual([]);
  }, 15_000);

  it('does not recover when the requested owner is not the barrier owner', () => {
    const root = makeRoot();
    const deadOwnerProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const owner = 'codegraph-overlay-generator:' + deadOwnerProcess.pid;
    const token = crypto.randomBytes(32).toString('hex');
    expect(jsonResult(runLease(root, ['--owner', owner, '--barrier-token', token, 'barrier-acquire'])).ok).toBe(true);
    const mismatch = jsonResult(runLease(root, ['--owner', 'codegraph-overlay-generator:' + process.pid, 'barrier-recover-stale']));
    expect(mismatch).toEqual(expect.objectContaining({ ok: false, reason: 'stale-overlay-generator-barrier-required', barrier: expect.objectContaining({ state: 'HELD', owner }) }));
  }, 15_000);

  it('does not recover a non-overlay barrier', () => {
    const root = makeRoot();
    const token = crypto.randomBytes(32).toString('hex');
    expect(jsonResult(runLease(root, ['--owner', 'ordinary-owner', '--barrier-token', token, 'barrier-acquire'])).ok).toBe(true);
    const mismatch = jsonResult(runLease(root, ['--owner', 'ordinary-owner', 'barrier-recover-stale']));
    expect(mismatch).toEqual(expect.objectContaining({ ok: false, reason: 'stale-overlay-generator-barrier-required', barrier: expect.objectContaining({ state: 'HELD', owner: 'ordinary-owner' }) }));
  }, 15_000);

  it('preserves monotonic transition order after recovery', () => {
    const root = makeRoot();
    const deadOwnerProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const owner = 'codegraph-overlay-generator:' + deadOwnerProcess.pid;
    const token = crypto.randomBytes(32).toString('hex');
    expect(jsonResult(runLease(root, ['--owner', owner, '--barrier-token', token, 'barrier-acquire'])).ok).toBe(true);
    const recovered = jsonResult(runLease(root, ['--owner', owner, 'barrier-recover-stale']));
    const transitions = recovered.barrier.transitions as Array<{ at: string; sequence: number }>;
    for (let index = 1; index < transitions.length; index += 1) {
      expect(Date.parse(transitions[index].at)).toBeGreaterThanOrEqual(Date.parse(transitions[index - 1].at));
      expect(transitions[index].sequence).toBe(transitions[index - 1].sequence + 1);
    }
  }, 15_000);

  it('rejects unrelated active build resource leases without partial release', () => {
    const root = makeRoot();
    const deadOwnerProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const owner = 'codegraph-overlay-generator:' + deadOwnerProcess.pid;
    const token = crypto.randomBytes(32).toString('hex');
    expect(jsonResult(runLease(root, ['--owner', owner, '--barrier-token', token, 'barrier-acquire'])).ok).toBe(true);
    expect(jsonResult(runLease(root, [
      '--owner', owner,
      '--ttl-ms', '3600000',
      '--resource-kind', 'build',
      '--resource-id', 'other-build-resource',
      '--resource-token-stdin',
      'resource-lease-acquire',
    ], token)).ok).toBe(true);
    const before = jsonResult(runLease(root, ['--owner', owner, 'status']));
    const recovered = jsonResult(runLease(root, ['--owner', owner, 'barrier-recover-stale']));
    expect(recovered).toEqual(expect.objectContaining({ ok: false, reason: 'unrelated-active-build-resource-leases' }));
    const after = jsonResult(runLease(root, ['--owner', owner, 'status']));
    expect(after.barrier).toEqual(before.barrier);
    expect(after.resourceLeases).toEqual(before.resourceLeases);
  }, 15_000);
  it('rejects a stale barrier binding even when the process is dead', () => {
    const root = makeRoot();
    const deadOwnerProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const owner = 'codegraph-overlay-generator:' + deadOwnerProcess.pid;
    const token = crypto.randomBytes(32).toString('hex');
    expect(jsonResult(runLease(root, ['--owner', owner, '--barrier-token', token, 'barrier-acquire'])).ok).toBe(true);
    const before = jsonResult(runLease(root, ['--owner', owner, 'status']));
    const recovered = jsonResult(runLease(root, ['--owner', owner, 'barrier-recover-stale']));
    expect(recovered).toEqual(expect.objectContaining({ ok: true, recovered: true }));
    expect(Date.parse(recovered.barrier.releasedAt)).toBeGreaterThanOrEqual(Date.parse(before.barrier.heartbeatAt));
    expect(recovered.barrier.heartbeatSequence).toBe(before.barrier.heartbeatSequence);
  }, 15_000);

  it('does not use mtime or age expiration while the generator process is alive', () => {
    const root = makeRoot();
    const owner = 'codegraph-overlay-generator:' + process.pid;
    const token = crypto.randomBytes(32).toString('hex');
    expect(jsonResult(runLease(root, ['--owner', owner, '--barrier-token', token, 'barrier-acquire'])).ok).toBe(true);
    const staleWalls = Date.now() - 365 * 24 * 60 * 60 * 1000;
    fs.utimesSync(path.join(root, 'tmp', 'agent-file-leases.json'), new Date(staleWalls), new Date(staleWalls));
    const recovered = jsonResult(runLease(root, ['--owner', owner, 'barrier-recover-stale']));
    expect(recovered).toEqual(expect.objectContaining({ ok: false, reason: 'barrier-owner-still-running', barrier: expect.objectContaining({ state: 'HELD' }) }));
  }, 15_000);
  it('fails closed while the named generator process is still alive', () => {
    const root = makeRoot();
    const owner = 'codegraph-overlay-generator:' + process.pid;
    const token = crypto.randomBytes(32).toString('hex');
    const acquired = jsonResult(runLease(root, ['--owner', owner, '--barrier-token', token, 'barrier-acquire']));
    expect(acquired.ok).toBe(true);

    const recovered = jsonResult(runLease(root, ['--owner', owner, 'barrier-recover-stale']));
    expect(recovered).toEqual(expect.objectContaining({
      ok: false,
      reason: 'barrier-owner-still-running',
      barrier: expect.objectContaining({ state: 'HELD', owner }),
    }));

    const released = jsonResult(runLease(root, ['--owner', owner, '--barrier-token', token, 'barrier-release']));
    expect(released.ok).toBe(true);
    expect(released.barrier.state).toBe('RELEASED');
  }, 15_000);
});
