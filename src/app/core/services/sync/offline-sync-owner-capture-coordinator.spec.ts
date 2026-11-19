import { describe, expect, it, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { OfflineSyncOwnerCaptureCoordinator } from './offline-sync-owner-capture-coordinator';
import { getOfflineSyncCaptureHooks } from './offline-sync-capture-registry';
import { getOfflineSyncActionCaptureHooks } from '../../../../services/sync/offline-sync-action-capture-registry';

const storage = (() => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
})();

describe('offline-sync-owner-capture-coordinator', () => {
  afterEach(() => {
    getOfflineSyncCaptureHooks();
    getOfflineSyncActionCaptureHooks();
  });

  it('installs shadow hooks only after an owner commit and disposes on invalidation', async () => {
    const coordinator = new OfflineSyncOwnerCaptureCoordinator({
      identityStorage: storage,
      storeOptions: { indexedDb: new IDBFactory(), dbName: 'owner-runtime-test' },
      featureEnabled: true,
      protocolProbe: async () => ({ minProtocolVersion: 1, deploymentEpoch: 1 }),
    });

    const capability = await coordinator.onOwnerCommitted('owner-1');
    expect(capability.reason).toBe('server-capabilities-missing');
    expect(coordinator.currentOwnerUserId()).toBe('owner-1');
    expect(getOfflineSyncCaptureHooks()?.enabled).toBe(true);
    expect(getOfflineSyncActionCaptureHooks()?.enabled).toBe(true);

    coordinator.onOwnerInvalidated();
    expect(coordinator.currentOwnerUserId()).toBeNull();
    expect(getOfflineSyncCaptureHooks()).toBeNull();
    expect(getOfflineSyncActionCaptureHooks()).toBeNull();
  });

  it('pulls server projections only in command mode and keeps capture alive when pull fails', async () => {
    let pulls = 0;
    const coordinator = new OfflineSyncOwnerCaptureCoordinator({
      identityStorage: storage,
      storeOptions: { indexedDb: new IDBFactory(), dbName: 'owner-runtime-projection-pull' },
      featureEnabled: true,
      protocolProbe: async () => ({
        minProtocolVersion: 1,
        deploymentEpoch: 1,
        capabilities: ['command-envelope-v1', 'field-lww-v1', 'domain-apply-v1', 'device-identity-v1', 'dependency-replay-v1', 'data-safety-command-store-v1'],
      }),
      pullProjections: async () => { pulls += 1; throw new Error('offline'); },
    });
    const capability = await coordinator.onOwnerCommitted('owner-pull');
    expect(capability.mode).toBe('command');
    expect(pulls).toBe(1);
    expect(getOfflineSyncCaptureHooks()?.enabled).toBe(true);
    coordinator.dispose();
  });

  it('drains pending commands only after the remote command capabilities are ready', async () => {
    let replays = 0;
    const coordinator = new OfflineSyncOwnerCaptureCoordinator({
      identityStorage: storage, storeOptions: { indexedDb: new IDBFactory(), dbName: 'owner-runtime-replay' }, featureEnabled: true,
      requiredCapabilities: ['command-envelope-v1', 'field-lww-v1'],
      protocolProbe: async () => ({ minProtocolVersion: 1, deploymentEpoch: 1, capabilities: ['command-envelope-v1', 'field-lww-v1', 'domain-apply-v1'] }),
      replayPendingCommands: async () => { replays += 1; },
    });
    const capability = await coordinator.onOwnerCommitted('owner-replay');
    expect(capability.mode).toBe('command');
    expect(replays).toBe(1);
    coordinator.dispose();
  });

  it('installs owner-local capture before awaiting a network capability probe', async () => {
    let resolveProbe!: (value: null) => void;
    const coordinator = new OfflineSyncOwnerCaptureCoordinator({
      identityStorage: storage,
      storeOptions: { indexedDb: new IDBFactory(), dbName: 'owner-runtime-install-before-probe' },
      featureEnabled: true,
      protocolProbe: () => new Promise(resolve => { resolveProbe = resolve; }),
    });

    const committing = coordinator.onOwnerCommitted('owner-offline-first');
    expect(coordinator.currentOwnerUserId()).toBe('owner-offline-first');
    expect(getOfflineSyncCaptureHooks()?.enabled).toBe(true);
    resolveProbe(null);
    await expect(committing).resolves.toMatchObject({ mode: 'shadow' });
    coordinator.dispose();
  });

  it('re-probes and drains the same owner store when connectivity returns', async () => {
    let probes = 0;
    let pulls = 0;
    let replays = 0;
    const capabilities = {
      minProtocolVersion: 1,
      deploymentEpoch: 1,
      capabilities: ['command-envelope-v1', 'field-lww-v1'],
    };
    const coordinator = new OfflineSyncOwnerCaptureCoordinator({
      identityStorage: storage,
      storeOptions: { indexedDb: new IDBFactory(), dbName: 'owner-runtime-connectivity-resume' },
      featureEnabled: true,
      requiredCapabilities: ['command-envelope-v1', 'field-lww-v1'],
      protocolProbe: async () => {
        probes += 1;
        return probes === 1 ? null : capabilities;
      },
      pullProjections: async () => { pulls += 1; },
      replayPendingCommands: async () => { replays += 1; },
    });

    const offline = await coordinator.onOwnerCommitted('owner-reconnect');
    expect(offline.mode).toBe('shadow');
    expect(pulls).toBe(0);
    expect(replays).toBe(0);
    const online = await coordinator.refreshCurrentOwner();

    expect(online?.mode).toBe('command');
    expect(probes).toBe(2);
    expect(pulls).toBe(2);
    expect(replays).toBe(1);
    expect(getOfflineSyncCaptureHooks()?.enabled).toBe(true);
    coordinator.dispose();
  });

  it('fails closed to shadow when protocol probing is unavailable', async () => {
    const coordinator = new OfflineSyncOwnerCaptureCoordinator({
      identityStorage: storage,
      storeOptions: { indexedDb: new IDBFactory(), dbName: 'owner-runtime-test-2' },
      featureEnabled: true,
      protocolProbe: async () => null,
    });
    const capability = await coordinator.onOwnerCommitted('owner-2');
    expect(capability.reason).toBe('server-probe-unavailable');
    coordinator.dispose();
  });
});
