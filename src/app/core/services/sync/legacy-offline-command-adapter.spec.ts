import { describe, expect, it } from 'vitest';
import type { RetryQueueItem } from './retry-queue.types';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import type { QueuedAction } from '../../../../services/action-queue.types';
import {
  applySyncRpcResultToOfflineCommand,
  queuedActionToOfflineCommand,
  retryQueueItemToOfflineCommand,
} from './legacy-offline-command-adapter';

const context = {
  ownerUserId: 'owner-1',
  installationId: 'installation-1',
  deviceId: 'device-1',
  nowMs: 1000,
} as const;

function retryItem(overrides: Partial<RetryQueueItem> = {}): RetryQueueItem {
  return {
    id: 'queue-1',
    type: 'task',
    operation: 'upsert',
    data: { id: 'task-1', content: 'offline' } as unknown as RetryQueueItem['data'],
    projectId: 'project-1',
    retryCount: 0,
    createdAt: 1000,
    operationId: 'operation-1',
    ...overrides,
  };
}

function action(overrides: Partial<QueuedAction> = {}): QueuedAction {
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
    ...overrides,
  };
}

describe('legacy-offline-command-adapter', () => {
  it('normalizes RetryQueue upsert to a registered entity update command', () => {
    const result = retryQueueItemToOfflineCommand(retryItem(), context);
    expect(result.command.command).toBe('task.update');
    expect(result.command.normalizedResultPatch).toMatchObject({ id: 'task-1', content: 'offline' });
  });

  it('preserves RetryQueue deletion as an explicit delete command', () => {
    const result = retryQueueItemToOfflineCommand(retryItem({
      operation: 'delete',
      data: { id: 'task-1', baseUpdatedAt: '2026-11-14T00:00:00.000Z' } as RetryQueueItem['data'],
    }), context);
    expect(result.command.command).toBe('task.delete');
    expect(result.command.normalizedResultPatch).toEqual({ deleted: true });
    expect(result.command.baseUpdatedAt).toBe('2026-11-14T00:00:00.000Z');
  });

  it('maps retry queue unknown outcomes without losing the operation id', () => {
    const result = retryQueueItemToOfflineCommand(retryItem({
      lastFailure: {
        errorType: 'timeout',
        message: 'network timeout',
        recordedAt: 2000,
        remoteOutcome: 'unknown',
      },
    }), context);

    expect(result.command.status).toBe('unknown');
    expect(result.command.operationId).toBe('operation-1');
    expect(result.command.idempotencyKey).toBe('operation-1');
    expect(result.command.entityType).toBe('task');
  });

  it('fails closed when a RetryQueue item has no entity id', () => {
    expect(() => retryQueueItemToOfflineCommand(retryItem({ data: { content: 'missing-id' } as unknown as RetryQueueItem['data'] }), context))
      .toThrow('missing an entity id');
  });

  it('fails closed when an ActionQueue action has no entity id', () => {
    expect(() => queuedActionToOfflineCommand(action({ entityId: undefined }), context))
      .toThrow(/entity id/i);
  });
  it('maps ActionQueue payload and sync state into a replayable command', () => {
    const result = queuedActionToOfflineCommand(action({ syncState: 'syncing' }), context);

    expect(result.command.status).toBe('sent');
    expect(result.command.normalizedResultPatch).toEqual({ content: 'queued' });
    expect(result.command.intent).toMatchObject({ source: 'action-queue', operationType: 'update' });
  });

  it('retains ActionQueue project scope, updatedAt baseline, and explicit write intent', () => {
    const result = queuedActionToOfflineCommand(action({
      payload: {
        task: { id: 'task-2', content: 'queued', updatedAt: '2026-11-14T00:00:00.000Z' },
        projectId: 'project-2',
        writeIntent: 'task_text_update',
      } as never,
    }), context);
    expect(result.command.projectId).toBe('project-2');
    expect(result.command.baseUpdatedAt).toBe('2026-11-14T00:00:00.000Z');
    expect(result.command.intent['writeIntent']).toBe('task_text_update');
  });

  it('preserves legacy RPC decision and maps accepted results to acked', () => {
    const command = retryQueueItemToOfflineCommand(retryItem(), context).command;
    const result: SyncRpcResult = {
      raw: { status: 'applied' },
      status: 'applied',
      decision: 'accepted',
      operationId: 'operation-1',
      serverUpdatedAt: '2026-11-14T00:00:00.000Z',
    };

    const updated = applySyncRpcResultToOfflineCommand(command, result);
    expect(updated.status).toBe('acked');
    expect(updated.remoteResult).toMatchObject({ decision: 'accepted', acknowledgedAtIso: '2026-11-14T00:00:00.000Z' });
  });
});