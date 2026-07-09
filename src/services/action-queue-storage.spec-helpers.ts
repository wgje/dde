import { signal } from '@angular/core';
import { vi } from 'vitest';

import type { ActionQueueContext } from './action-queue-storage.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';

export const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

export const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

export const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

export const mockNetworkAwarenessService = {
  setStoragePressure: vi.fn(),
};

const mockQueueBackupState = {
  queues: new Map<string, QueuedAction[]>(),
  deadLetters: new Map<string, DeadLetterItem[]>(),
  recordFoundOwners: new Set<string>(),
  deadLetterRecordFoundOwners: new Set<string>(),
};

export const mockQueueBackupService = {
  backupQueue: vi.fn(async (queue: QueuedAction[], ownerUserId: string) => {
    mockQueueBackupState.queues.set(ownerUserId, queue);
    mockQueueBackupState.recordFoundOwners.add(ownerUserId);
    return true;
  }),
  restoreQueue: vi.fn(async (ownerUserId: string) => (
    mockQueueBackupState.recordFoundOwners.has(ownerUserId)
      ? (mockQueueBackupState.queues.get(ownerUserId) ?? [])
      : null
  )),
  backupDeadLetters: vi.fn(async (deadLetters: DeadLetterItem[], ownerUserId: string) => {
    mockQueueBackupState.deadLetters.set(ownerUserId, deadLetters);
    mockQueueBackupState.deadLetterRecordFoundOwners.add(ownerUserId);
    return true;
  }),
  restoreDeadLetters: vi.fn(async (ownerUserId: string) => (
    mockQueueBackupState.deadLetterRecordFoundOwners.has(ownerUserId)
      ? (mockQueueBackupState.deadLetters.get(ownerUserId) ?? [])
      : null
  )),
  updateQueue: vi.fn(async (
    ownerUserId: string,
    updater: (
      queue: QueuedAction[],
      context: { recordFound: boolean },
    ) => QueuedAction[],
  ) => {
    const recordFound = mockQueueBackupState.recordFoundOwners.has(ownerUserId);
    const currentQueue = recordFound ? (mockQueueBackupState.queues.get(ownerUserId) ?? []) : [];
    const updatedQueue = updater(currentQueue, { recordFound });
    mockQueueBackupState.queues.set(ownerUserId, updatedQueue);
    mockQueueBackupState.recordFoundOwners.add(ownerUserId);
    return updatedQueue;
  }),
  getQueueBackupRecordId: vi.fn((userId: string) => `queue-backup:${userId}`),
};

export function resetQueueBackupMocks(): void {
  mockQueueBackupState.queues.clear();
  mockQueueBackupState.deadLetters.clear();
  mockQueueBackupState.recordFoundOwners.clear();
  mockQueueBackupState.deadLetterRecordFoundOwners.clear();
  mockQueueBackupService.backupQueue.mockReset();
  mockQueueBackupService.backupQueue.mockImplementation(async (queue: QueuedAction[], ownerUserId: string) => {
    mockQueueBackupState.queues.set(ownerUserId, queue);
    mockQueueBackupState.recordFoundOwners.add(ownerUserId);
    return true;
  });
  mockQueueBackupService.restoreQueue.mockReset();
  mockQueueBackupService.restoreQueue.mockImplementation(async (ownerUserId: string) => (
    mockQueueBackupState.recordFoundOwners.has(ownerUserId)
      ? (mockQueueBackupState.queues.get(ownerUserId) ?? [])
      : null
  ));
  mockQueueBackupService.backupDeadLetters.mockReset();
  mockQueueBackupService.backupDeadLetters.mockImplementation(async (deadLetters: DeadLetterItem[], ownerUserId: string) => {
    mockQueueBackupState.deadLetters.set(ownerUserId, deadLetters);
    mockQueueBackupState.deadLetterRecordFoundOwners.add(ownerUserId);
    return true;
  });
  mockQueueBackupService.restoreDeadLetters.mockReset();
  mockQueueBackupService.restoreDeadLetters.mockImplementation(async (ownerUserId: string) => (
    mockQueueBackupState.deadLetterRecordFoundOwners.has(ownerUserId)
      ? (mockQueueBackupState.deadLetters.get(ownerUserId) ?? [])
      : null
  ));
  mockQueueBackupService.updateQueue.mockReset();
  mockQueueBackupService.updateQueue.mockImplementation(async (
    ownerUserId: string,
    updater: (
      queue: QueuedAction[],
      context: { recordFound: boolean },
    ) => QueuedAction[],
  ) => {
    const recordFound = mockQueueBackupState.recordFoundOwners.has(ownerUserId);
    const currentQueue = recordFound ? (mockQueueBackupState.queues.get(ownerUserId) ?? []) : [];
    const updatedQueue = updater(currentQueue, { recordFound });
    mockQueueBackupState.queues.set(ownerUserId, updatedQueue);
    mockQueueBackupState.recordFoundOwners.add(ownerUserId);
    return updatedQueue;
  });
  mockQueueBackupService.getQueueBackupRecordId.mockReset();
  mockQueueBackupService.getQueueBackupRecordId.mockImplementation(
    (userId: string) => `queue-backup:${userId}`,
  );
}

export async function flushQueueBackupRestore(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export function createMockAction(overrides: Partial<QueuedAction> = {}): QueuedAction {
  const timestamp = typeof overrides.timestamp === 'number' ? overrides.timestamp : Date.now();

  return {
    id: crypto.randomUUID(),
    type: 'update',
    entityType: 'task',
    entityId: 'task-1',
    payload: { task: { id: 'task-1', title: 'Test' } as any, projectId: 'proj-1' },
    timestamp,
    localCommittedAt: typeof overrides.localCommittedAt === 'number' ? overrides.localCommittedAt : timestamp,
    syncState: overrides.syncState ?? 'pending_sync',
    retryCount: 0,
    priority: 'normal',
    ...overrides,
    operationId: overrides.operationId ?? crypto.randomUUID(),
  };
}

export function createMockContext(overrides: Partial<ActionQueueContext> = {}): ActionQueueContext {
  return {
    dequeue: vi.fn(),
    syncSentryContext: vi.fn(),
    processQueue: vi.fn().mockResolvedValue(undefined),
    pendingActions: signal<QueuedAction[]>([]),
    queueSize: signal(0),
    ...overrides,
  };
}
