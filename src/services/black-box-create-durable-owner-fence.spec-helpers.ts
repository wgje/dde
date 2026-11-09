import { describe, expect, it, vi } from 'vitest';

import type { BlackBoxEntry } from '../models/focus';
import { ErrorCodes, type OperationError, type Result } from '../utils/result';
import type { BlackBoxService } from './black-box.service';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
};

export interface BlackBoxCreateDurableOwnerFenceSpecContext {
  service: BlackBoxService;
  mockAuthService: {
    currentUserId: ReturnType<typeof vi.fn>;
    captureAuthIdentityFence: ReturnType<typeof vi.fn>;
  };
  mockSyncService: {
    loadFromLocal: ReturnType<typeof vi.fn>;
    scheduleSync: ReturnType<typeof vi.fn>;
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function expectStaleOwnerFailure(result: Result<unknown, OperationError>): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(ErrorCodes.SYNC_AUTH_EXPIRED);
  }
}

function expectOperationFailure(result: Awaited<ReturnType<BlackBoxService['createDurably']>>): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(ErrorCodes.OPERATION_FAILED);
  }
}

function createStoredEntry(clientOperationId: string): BlackBoxEntry {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: null,
    userId: 'test-user',
    content: 'durable owner-a entry',
    date: '2026-08-01',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    completedAt: null,
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    localCreatedAt: '2026-08-01T00:00:00.000Z',
    snoozeCount: 0,
    syncStatus: 'pending',
    focusMeta: null,
    clientOperationId,
  };
}

export function registerBlackBoxCreateDurableOwnerFenceSpecs(
  getContext: () => BlackBoxCreateDurableOwnerFenceSpecContext,
): void {
  describe('createDurably owner fence', () => {
    it('rejects an explicit foreign owner before the in-memory idempotency return', async () => {
      const { service, mockSyncService } = getContext();
      const clientOperationId = 'black-box-create-owner-fence:existing';
      const existing = service.create({ content: 'existing', clientOperationId });
      if (!existing.ok) throw new Error('Fixture create failed');
      mockSyncService.scheduleSync.mockClear();

      const result = await service.createDurably({
        content: 'foreign replay',
        clientOperationId,
        userId: 'user-b',
      });

      expectStaleOwnerFailure(result);
      expect(service.entriesMap().get(existing.value.id)).toEqual(existing.value);
      expect(mockSyncService.scheduleSync).not.toHaveBeenCalled();
    });

    it.each([
      { identity: 'stable A', transitions: [], publishes: true },
      { identity: 'A to B', transitions: [['user-b', 'fence-b']], publishes: false },
      {
        identity: 'A to B to A',
        transitions: [['user-b', 'fence-b'], ['test-user', 'fence-a2']],
        publishes: false,
      },
      {
        identity: 'same-owner relogin',
        transitions: [['test-user', 'fence-a2']],
        publishes: false,
      },
    ])('publishes a durable create only for $identity', async ({ transitions, publishes }) => {
      const { service, mockAuthService, mockSyncService } = getContext();
      const persisted = createDeferred<void>();
      mockSyncService.scheduleSync.mockReturnValueOnce(persisted.promise);

      const pending = service.createDurably({ content: 'owner-a durable entry' });
      expect(service.entriesMap().size).toBe(0);

      for (const [owner, fence] of transitions) {
        mockAuthService.currentUserId.mockReturnValue(owner);
        mockAuthService.captureAuthIdentityFence.mockReturnValue(fence);
      }
      persisted.resolve(undefined);
      const result = await pending;

      expect(result.ok).toBe(publishes);
      if (!publishes) expectStaleOwnerFailure(result);
      expect(service.entriesMap().size).toBe(publishes ? 1 : 0);
      expect(mockSyncService.scheduleSync).toHaveBeenCalledTimes(1);
      expect(mockSyncService.scheduleSync).toHaveBeenCalledWith(expect.objectContaining({
        content: 'owner-a durable entry',
        userId: 'test-user',
      }));
    });

    it('rejects a durable idempotency lookup that completes after owner drift', async () => {
      const { service, mockAuthService, mockSyncService } = getContext();
      const clientOperationId = 'black-box-create-owner-fence:durable-existing';
      const load = createDeferred<BlackBoxEntry[]>();
      mockSyncService.loadFromLocal.mockReturnValueOnce(load.promise);

      const pending = service.createDurably({
        content: 'durable owner-a entry',
        clientOperationId,
      });
      mockAuthService.currentUserId.mockReturnValue('user-b');
      mockAuthService.captureAuthIdentityFence.mockReturnValue('fence-b');
      load.resolve([createStoredEntry(clientOperationId)]);
      const result = await pending;

      expectStaleOwnerFailure(result);
      expect(service.entriesMap().size).toBe(0);
      expect(mockSyncService.scheduleSync).not.toHaveBeenCalled();
    });

    it('preserves lookup failure classification when owner drifts before rejection', async () => {
      const { service, mockAuthService, mockSyncService } = getContext();
      const load = createDeferred<BlackBoxEntry[]>();
      mockSyncService.loadFromLocal.mockReturnValueOnce(load.promise);

      const pending = service.createDurably({
        content: 'lookup failure under owner drift',
        clientOperationId: 'black-box-create-owner-fence:lookup-failure',
      });
      mockAuthService.currentUserId.mockReturnValue('user-b');
      mockAuthService.captureAuthIdentityFence.mockReturnValue('fence-b');
      load.reject(new Error('local lookup failed'));
      const result = await pending;

      expectOperationFailure(result);
      expect(service.entriesMap().size).toBe(0);
      expect(mockSyncService.scheduleSync).not.toHaveBeenCalled();
    });

    it('preserves persistence failure classification when owner drifts before rejection', async () => {
      const { service, mockAuthService, mockSyncService } = getContext();
      const persisted = createDeferred<void>();
      mockSyncService.scheduleSync.mockReturnValueOnce(persisted.promise);

      const pending = service.createDurably({ content: 'persistence failure under owner drift' });
      mockAuthService.currentUserId.mockReturnValue('user-b');
      mockAuthService.captureAuthIdentityFence.mockReturnValue('fence-b');
      persisted.reject(new Error('local persistence failed'));
      const result = await pending;

      expectOperationFailure(result);
      expect(service.entriesMap().size).toBe(0);
      expect(mockSyncService.scheduleSync).toHaveBeenCalledTimes(1);
    });

    it.each([
      { identity: 'stable A', transitions: [], publishes: true },
      { identity: 'A to B', transitions: [['user-b', 'fence-b']], publishes: false },
      {
        identity: 'A to B to A',
        transitions: [['user-b', 'fence-b'], ['test-user', 'fence-a2']],
        publishes: false,
      },
      {
        identity: 'same-owner relogin',
        transitions: [['test-user', 'fence-a2']],
        publishes: false,
      },
    ])('fences durable delete publication across $identity', async ({ transitions, publishes }) => {
      const { service, mockAuthService, mockSyncService } = getContext();
      const created = service.create({ content: 'entry retained across stale durable delete' });
      if (!created.ok) throw new Error('Fixture create failed');
      mockSyncService.scheduleSync.mockClear();
      const persisted = createDeferred<void>();
      mockSyncService.scheduleSync.mockReturnValueOnce(persisted.promise);

      const pending = service.deleteDurably(created.value.id);
      for (const [userId, fence] of transitions) {
        mockAuthService.currentUserId.mockReturnValue(userId);
        mockAuthService.captureAuthIdentityFence.mockReturnValue(fence);
      }
      persisted.resolve();
      const result = await pending;

      expect(result.ok).toBe(publishes);
      if (!publishes) expectStaleOwnerFailure(result);
      expect(service.entriesMap().get(created.value.id)?.deletedAt != null).toBe(publishes);
      expect(mockSyncService.scheduleSync).toHaveBeenCalledTimes(1);
    });
  });
}
