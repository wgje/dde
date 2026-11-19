import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { RetryQueueItem } from './retry-queue.types';
import type { QueuedAction } from '../../../../services/action-queue.types';
import { IndexedDbOfflineCommandStore } from '../../../../services/sync/offline-command-store';
import { OfflineSyncCommandCoordinator } from '../../../../services/sync/offline-sync-command-coordinator';
import type { OfflineSyncCommandEnvelope } from '../../../../services/sync/offline-sync-command-envelope';
import { LegacyOfflineCommandCaptureService } from './legacy-offline-command-capture.service';

const context = {
  ownerUserId: 'owner-1',
  installationId: 'installation-1',
  deviceId: 'device-1',
  nowMs: 1000,
} as const;

function retryItem(): RetryQueueItem {
  return {
    id: 'queue-1',
    type: 'task',
    operation: 'upsert',
    data: { id: 'task-1', content: 'offline' } as unknown as RetryQueueItem['data'],
    projectId: 'project-1',
    retryCount: 0,
    createdAt: 1000,
    operationId: 'operation-1',
  };
}

function action(): QueuedAction {
  return {
    id: 'action-1',
    operationId: 'operation-2',
    type: 'update',
    entityType: 'task',
    entityId: 'task-2',
    payload: { content: 'queued' } as never,
    timestamp: 1000,
    localCommittedAt: 1000,
    syncState: 'pending_sync',
    retryCount: 0,
  };
}

describe('legacy-offline-command-capture', () => {
  it('captures RetryQueue records into the local command store', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'capture-test-1' });
    const capture = new LegacyOfflineCommandCaptureService({
      coordinator: new OfflineSyncCommandCoordinator({ store }),
      context,
    });

    const result = await capture.captureRetryQueueItem(retryItem());
    const commands = await store.listCommands<OfflineSyncCommandEnvelope>('owner-1');

    expect(result.command.operationId).toBe('operation-1');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command.normalizedResultPatch).toMatchObject({ id: 'task-1' });
  });

  it('captures ActionQueue records without consuming or mutating the legacy queue', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'capture-test-2' });
    const capture = new LegacyOfflineCommandCaptureService({
      coordinator: new OfflineSyncCommandCoordinator({ store }),
      context,
    });

    const result = await capture.captureQueuedAction(action());
    expect(result.command.operationId).toBe('operation-2');
    expect(result.command.status).toBe('pending');
  });
});
