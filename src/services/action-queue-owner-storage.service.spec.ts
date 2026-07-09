import { Injector, runInInjectionContext, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import { ActionQueueOwnerStorageService } from './action-queue-owner-storage.service';
import type { ActionQueueOwnerStorageRuntime } from './action-queue-owner-storage.types';
import type { QueuedAction } from './action-queue.types';
import { LoggerService } from './logger.service';
import { QueueBackupService } from './queue-backup.service';
import { ToastService } from './toast.service';

describe('ActionQueueOwnerStorageService', () => {
  const loggerCategory = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const loggerService = {
    category: vi.fn(() => loggerCategory),
  };
  const toastService = {
    info: vi.fn(),
    warning: vi.fn(),
  };
  const queueBackupService = {
    backupQueue: vi.fn(),
    backupDeadLetters: vi.fn(),
    restoreDeadLetters: vi.fn(),
    restoreQueue: vi.fn(),
    updateQueue: vi.fn(),
  };

  let service: ActionQueueOwnerStorageService;
  let currentUserId: ReturnType<typeof signal<string | null>>;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    currentUserId = signal<string | null>('user-a');

    const injector = Injector.create({
      providers: [
        ActionQueueOwnerStorageService,
        { provide: AuthService, useValue: { currentUserId } },
        { provide: LoggerService, useValue: loggerService },
        { provide: QueueBackupService, useValue: queueBackupService },
        { provide: ToastService, useValue: toastService },
      ],
    });
    service = runInInjectionContext(injector, () => injector.get(ActionQueueOwnerStorageService));
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('clears the original owner snapshot when quota backup completes after owner changes', async () => {
    const userAKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
    const userBKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-b`;
    const staleUserAction = createQueuedAction('stale-user-a-action');
    const otherUserAction = createQueuedAction('user-b-action');
    const freshAction = createQueuedAction('fresh-user-a-action');
    const originalLocalStorage = globalThis.localStorage;
    const storage = createQuotaStorage(userAKey, [
      [userAKey, JSON.stringify([staleUserAction])],
      [userBKey, JSON.stringify([otherUserAction])],
    ]);
    let resolveBackup: (success: boolean) => void = () => {};
    queueBackupService.backupQueue.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveBackup = resolve;
    }));

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
      writable: true,
    });

    try {
      service.saveCurrentQueueToStorage(createRuntime([freshAction]));
      currentUserId.set('user-b');
      resolveBackup(true);
      await flushAsyncBackup();

      expect(queueBackupService.backupQueue).toHaveBeenCalledWith([freshAction], 'user-a');
      expect(globalThis.localStorage.getItem(userAKey)).toBeNull();
      expect(globalThis.localStorage.getItem(userBKey)).toBe(JSON.stringify([otherUserAction]));
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
        writable: true,
      });
    }
  });

  it('does not enter escape mode when quota backup succeeds but warning toast fails', async () => {
    const userAKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
    const staleUserAction = createQueuedAction('stale-user-a-action');
    const freshAction = createQueuedAction('fresh-user-a-action');
    const runtime = createRuntime([freshAction]);
    const originalLocalStorage = globalThis.localStorage;
    const storage = createQuotaStorage(userAKey, [
      [userAKey, JSON.stringify([staleUserAction])],
    ]);
    let resolveBackup: (success: boolean) => void = () => {};
    queueBackupService.backupQueue.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveBackup = resolve;
    }));
    toastService.warning.mockImplementationOnce(() => {
      throw new Error('toast failed');
    });

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
      writable: true,
    });

    try {
      service.saveCurrentQueueToStorage(runtime);
      resolveBackup(true);
      await flushAsyncBackup();

      expect(runtime.freezeQueueWrites).toHaveBeenCalledWith('quota_exceeded');
      expect(runtime.freezeQueueWrites).not.toHaveBeenCalledWith('backup_failed');
      expect(runtime.triggerStorageFailureEscapeMode).not.toHaveBeenCalled();
      expect(globalThis.localStorage.getItem(userAKey)).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
        writable: true,
      });
    }
  });

  it('freezes queue writes when durable queue backup rejects after local snapshot save', async () => {
    const runtime = createRuntime([]);
    const action = createQueuedAction('backup-reject-action');
    const backupError = new Error('backup rejected');
    queueBackupService.backupQueue.mockRejectedValueOnce(backupError);

    await expect(service.persistQueueSnapshotForOwner('user-a', [action], runtime))
      .resolves.toBe(false);

    expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`))
      .toBe(JSON.stringify([action]));
    expect(runtime.freezeQueueWrites).toHaveBeenCalledWith('storage_failure');
    expect(runtime.triggerStorageFailureEscapeMode).toHaveBeenCalledTimes(1);
  });

  it('still freezes queue writes when durable backup rejection logging fails', async () => {
    const runtime = createRuntime([]);
    const action = createQueuedAction('backup-reject-logger-action');
    queueBackupService.backupQueue.mockRejectedValueOnce(new Error('backup rejected'));
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('logger failed');
    });

    await expect(service.persistQueueSnapshotForOwner('user-a', [action], runtime))
      .resolves.toBe(false);

    expect(runtime.freezeQueueWrites).toHaveBeenCalledWith('storage_failure');
    expect(runtime.triggerStorageFailureEscapeMode).toHaveBeenCalledTimes(1);
  });

  it('falls back to local queue mutation when IndexedDB update warning logging fails', async () => {
    const runtime = createRuntime([]);
    const action = createQueuedAction('fallback-mutation-action');
    queueBackupService.updateQueue.mockRejectedValueOnce(new Error('idb update failed'));
    queueBackupService.backupQueue.mockResolvedValueOnce(true);
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('logger failed');
    });

    const result = await service.persistQueueMutationForOwner('user-a', () => [action], runtime);

    expect(result).toHaveLength(1);
    expect(result?.[0]?.id).toBe(action.id);
    expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`))
      .toBe(JSON.stringify(result));
    expect(queueBackupService.backupQueue).toHaveBeenCalledWith(result, 'user-a');
  });

  it('does not retry a queue updater after IndexedDB absorbs the updater error', async () => {
    const runtime = createRuntime([]);
    const updaterError = new Error('updater failed');
    const updater = vi.fn(() => {
      throw updaterError;
    });
    queueBackupService.updateQueue.mockImplementationOnce(async (
      _ownerUserId: string,
      update: (queue: QueuedAction[], context: { recordFound: boolean }) => QueuedAction[],
    ) => {
      try {
        update([], { recordFound: true });
      } catch {
        return null;
      }
      return null;
    });

    await expect(service.persistQueueMutationForOwner('user-a', updater, runtime))
      .rejects.toBe(updaterError);
    expect(updater).toHaveBeenCalledTimes(1);
    expect(queueBackupService.backupQueue).not.toHaveBeenCalled();
  });
});

function createRuntime(queue: QueuedAction[]): ActionQueueOwnerStorageRuntime {
  return {
    clearQueueFreeze: vi.fn(),
    deadLetterQueue: vi.fn(() => []),
    freezeQueueWrites: vi.fn(),
    pendingActions: vi.fn(() => queue),
    requestQueueProcessing: vi.fn(),
    saveQueueToStorage: vi.fn(),
    setDeadLetterQueue: vi.fn(),
    setDeadLetterSize: vi.fn(),
    setPendingActions: vi.fn(),
    setQueueSize: vi.fn(),
    syncSentryContext: vi.fn(),
    triggerStorageFailureEscapeMode: vi.fn(),
  };
}

function createQueuedAction(id: string): QueuedAction {
  return {
    entityId: 'task-1',
    entityType: 'task',
    id,
    localCommittedAt: 100,
    operationId: `operation-${id}`,
    payload: {
      projectId: 'project-1',
      task: { id: 'task-1', title: id } as never,
    },
    priority: 'normal',
    retryCount: 0,
    syncState: 'pending_sync',
    timestamp: 100,
    type: 'update',
  };
}

function createQuotaStorage(
  quotaKey: string,
  entries: Array<[string, string]>,
): Storage {
  const storageData = new Map<string, string>(entries);
  return {
    clear: () => storageData.clear(),
    getItem: (key: string) => storageData.get(key) ?? null,
    key: (index: number) => Array.from(storageData.keys())[index] ?? null,
    get length() {
      return storageData.size;
    },
    removeItem: (key: string) => {
      storageData.delete(key);
    },
    setItem: (key: string, value: string) => {
      if (key === quotaKey) {
        const error = new Error('quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      storageData.set(key, String(value));
    },
  };
}

async function flushAsyncBackup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
