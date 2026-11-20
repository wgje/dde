import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbOfflineCommandStore } from '../../../../services/sync/offline-command-store';
import { negotiateOfflineSyncCapabilities } from '../../../../services/sync/offline-sync-capability-gate';
import { createOfflineSyncCaptureRuntime } from './offline-sync-capture-runtime';
import { getOfflineSyncCaptureHooks } from './offline-sync-capture-registry';
import { getOfflineSyncActionCaptureHooks } from '../../../../services/sync/offline-sync-action-capture-registry';

describe('offline-sync-capture-runtime', () => {
  it('keeps the default legacy mode inert', () => {
    const runtime = createOfflineSyncCaptureRuntime({
      store: new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'runtime-test-1' }),
      enabled: false,
      capability: negotiateOfflineSyncCapabilities({ clientProtocolVersion: 1, server: null }),
      ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-1',
    });
    runtime.install();
    expect(runtime.mode).toBe('legacy');
    expect(getOfflineSyncCaptureHooks()?.enabled).toBe(false);
    expect(getOfflineSyncActionCaptureHooks()?.enabled).toBe(false);
    runtime.dispose();
  });

  it('installs shadow hooks without enabling command mode when capabilities are incomplete', () => {
    const runtime = createOfflineSyncCaptureRuntime({
      store: new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'runtime-test-2' }),
      enabled: true,
      capability: negotiateOfflineSyncCapabilities({
        clientProtocolVersion: 1,
        server: { minProtocolVersion: 1, deploymentEpoch: 1, capabilities: ['command-envelope-v1'] },
      }),
      ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-1',
    });
    runtime.install();
    expect(runtime.mode).toBe('shadow');
    expect(getOfflineSyncCaptureHooks()?.enabled).toBe(true);
    expect(getOfflineSyncActionCaptureHooks()?.enabled).toBe(true);
    runtime.dispose();
  });
});