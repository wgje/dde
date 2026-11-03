import { Injector, runInInjectionContext, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import { ActionQueueOwnerStorageService } from './action-queue-owner-storage.service';
import type { ActionQueueOwnerStorageRuntime } from './action-queue-owner-storage.types';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
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
    restoreQueueSnapshot: vi.fn(),
    updateQueue: vi.fn(),
    updateQueueStrictly: vi.fn(),
  };

  let service: ActionQueueOwnerStorageService;
  let currentUserId: ReturnType<typeof signal<string | null>>;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    Object.values(queueBackupService).forEach(mock => mock.mockReset());
    queueBackupService.backupDeadLetters.mockResolvedValue(true);
    queueBackupService.updateQueueStrictly.mockImplementation(async (
      ownerUserId: string,
      updater: (queue: QueuedAction[], context: { recordFound: boolean }) => QueuedAction[],
    ) => {
      const queue = await queueBackupService.updateQueue(ownerUserId, updater);
      return queue === null || queue === undefined
        ? { status: 'storage-failed' }
        : { status: 'committed', queue };
    });
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

  it('stages queue and dead letters as one immutable owner snapshot', async () => {
    const action = createQueuedAction('staged-action');
    const deadLetter = createDeadLetter('staged-dead-letter');
    queueBackupService.restoreQueueSnapshot.mockResolvedValueOnce({
      recordFound: true,
      actions: [action],
      savedAt: new Date(action.timestamp).toISOString(),
    });
    queueBackupService.backupQueue.mockResolvedValueOnce(true);
    queueBackupService.restoreDeadLetters.mockResolvedValueOnce([deadLetter]);

    const result = await service.stageCurrentOwnerStorage(1, 'user-a', () => 1);

    expect(result).toEqual({
      outcome: 'ready',
      state: {
        queue: [expect.objectContaining({ id: action.id })],
        queueSize: 1,
        deadLetters: [expect.objectContaining({
          action: expect.objectContaining({ id: deadLetter.action.id }),
        })],
        deadLetterSize: 1,
        queueFrozen: false,
        queueFreezeReason: null,
      },
    });
    expect(Object.isFrozen(result.state?.queue)).toBe(true);
    expect(Object.isFrozen(result.state?.deadLetters)).toBe(true);
    expect(queueBackupService.backupQueue).not.toHaveBeenCalled();
    expect(queueBackupService.backupDeadLetters).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('refreshes only the current owner queue mirror from a restored snapshot', () => {
    const staleAction = createQueuedAction('stale-mirror-action');
    const restoredAction = createQueuedAction('restored-mirror-action');
    restoredAction.operationId = '88888888-8888-4888-8888-888888888888';
    const storageKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
    localStorage.setItem(storageKey, JSON.stringify([staleAction]));

    expect(service.refreshQueueMirrorForOwnerAfterRestore('user-a', [restoredAction])).toBe(true);
    expect(JSON.parse(localStorage.getItem(storageKey) ?? 'null')).toEqual([restoredAction]);
    expect(service.refreshQueueMirrorForOwnerAfterRestore('user-b', [staleAction])).toBe(false);
    expect(JSON.parse(localStorage.getItem(storageKey) ?? 'null')).toEqual([restoredAction]);
    expect(queueBackupService.backupQueue).not.toHaveBeenCalled();
    expect(queueBackupService.restoreQueueSnapshot).not.toHaveBeenCalled();
  });

  it('leaves legacy queue and dead-letter storage untouched while staging', async () => {
    const legacyAction = createQueuedAction('legacy-staged-action');
    const legacyDeadLetter = createDeadLetter('legacy-staged-dead-letter');
    const queueValue = JSON.stringify([legacyAction]);
    const deadLetterValue = JSON.stringify([legacyDeadLetter]);
    localStorage.setItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, queueValue);
    localStorage.setItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, deadLetterValue);
    queueBackupService.restoreQueueSnapshot.mockResolvedValueOnce({
      recordFound: true,
      actions: [],
      savedAt: new Date(legacyAction.timestamp).toISOString(),
    });
    queueBackupService.restoreDeadLetters.mockResolvedValueOnce([]);

    await expect(service.stageCurrentOwnerStorage(1, 'user-a', () => 1)).resolves.toMatchObject({
      outcome: 'ready',
    });

    expect(localStorage.getItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY)).toBe(queueValue);
    expect(localStorage.getItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY)).toBe(deadLetterValue);
    expect(localStorage.length).toBe(2);
    expect(queueBackupService.backupQueue).not.toHaveBeenCalled();
    expect(queueBackupService.backupDeadLetters).not.toHaveBeenCalled();
  });

  it.each(['failed', 'stale'] as const)(
    'does not durably save staged queue when dead-letter staging becomes %s',
    async expectedOutcome => {
      const action = createQueuedAction(`deferred-${expectedOutcome}`);
      queueBackupService.restoreQueueSnapshot.mockResolvedValueOnce({
        recordFound: true,
        actions: [action],
        savedAt: new Date(action.timestamp).toISOString(),
      });
      let resolveDeadLetters!: (value: DeadLetterItem[]) => void;
      const corruptKey = `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`;
      if (expectedOutcome === 'failed') {
        localStorage.setItem(corruptKey, '{}');
        queueBackupService.restoreDeadLetters.mockResolvedValueOnce([]);
      } else {
        queueBackupService.restoreDeadLetters.mockReturnValueOnce(new Promise(resolve => {
          resolveDeadLetters = resolve;
        }));
      }
      let generation = 1;
      const staging = service.stageCurrentOwnerStorage(1, 'user-a', () => generation);

      if (expectedOutcome === 'stale') {
        await vi.waitFor(() => expect(resolveDeadLetters).toBeTypeOf('function'));
        generation = 2;
        resolveDeadLetters([]);
      }

      await expect(staging).resolves.toEqual({ outcome: expectedOutcome });
      expect(queueBackupService.backupQueue).not.toHaveBeenCalled();
      expect(queueBackupService.backupDeadLetters).not.toHaveBeenCalled();
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`)).toBeNull();
      expect(localStorage.getItem(corruptKey)).toBe(expectedOutcome === 'failed' ? '{}' : null);
    },
  );

  it('returns stale without a publishable snapshot after an A to B to A generation change', async () => {
    const action = createQueuedAction('stale-stage-action');
    let release!: (value: { recordFound: true; actions: QueuedAction[]; savedAt: string }) => void;
    queueBackupService.restoreQueueSnapshot.mockReturnValueOnce(new Promise(resolve => {
      release = resolve;
    }));
    let generation = 1;
    const staging = service.stageCurrentOwnerStorage(1, 'user-a', () => generation);
    currentUserId.set('user-b');
    currentUserId.set('user-a');
    generation = 2;
    release({ recordFound: true, actions: [action], savedAt: new Date(action.timestamp).toISOString() });

    await expect(staging).resolves.toEqual({ outcome: 'stale' });
    expect(queueBackupService.restoreDeadLetters).not.toHaveBeenCalled();
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

  it('does not fall back to a stale local mirror for a membership-reducing mutation', async () => {
    const runtime = createRuntime([]);
    const actionA = createQueuedAction('action-a');
    const actionB = createQueuedAction('action-b');
    localStorage.setItem(
      `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`,
      JSON.stringify([actionA]),
    );
    queueBackupService.updateQueueStrictly.mockResolvedValueOnce({ status: 'storage-failed' });
    queueBackupService.updateQueue.mockRejectedValueOnce(new Error('latest [A,B] unavailable'));
    queueBackupService.backupQueue.mockResolvedValueOnce(true);

    const result = await service.persistQueueMutationForOwner(
      'user-a',
      queue => queue.filter(action => action.id !== actionA.id),
      runtime,
    );

    expect(result).toBeNull();
    expect(queueBackupService.backupQueue).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`)!))
      .toEqual([actionA]);
    expect(actionB.id).toBe('action-b');
  });

  it('keeps durable [A,B] when a strict latest-IDB mutation fails against stale local [A]', async () => {
    const runtime = createRuntime([]);
    const actionA = createQueuedAction('strict-action-a');
    const actionB = createQueuedAction('strict-action-b');
    const durableQueue = [actionA, actionB];
    localStorage.setItem(
      `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`,
      JSON.stringify([actionA]),
    );
    queueBackupService.updateQueueStrictly.mockImplementationOnce(async (_ownerUserId, updater) => {
      updater(durableQueue, { recordFound: true });
      return { status: 'storage-failed' };
    });

    const result = await service.persistQueueMutationStrictlyForOwner(
      'user-a',
      queue => queue.filter(action => action.id !== actionA.id),
      runtime,
    );

    expect(result).toEqual({ status: 'storage-failed' });
    expect(durableQueue).toEqual([actionA, actionB]);
    expect(JSON.parse(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`)!))
      .toEqual([actionA]);
    expect(queueBackupService.backupQueue).not.toHaveBeenCalled();
  });

  it('bases strict removal on latest-IDB and mirrors the committed queue', async () => {
    const runtime = createRuntime([]);
    const actionA = createQueuedAction('strict-remove-a');
    const actionB = createQueuedAction('strict-retain-b');
    localStorage.setItem(
      `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`,
      JSON.stringify([actionA]),
    );
    queueBackupService.updateQueueStrictly.mockImplementationOnce(async (_ownerUserId, updater) => {
      const queue = updater([actionA, actionB], { recordFound: true });
      return { status: 'committed', queue };
    });

    const result = await service.persistQueueMutationStrictlyForOwner(
      'user-a',
      queue => queue.filter(action => action.id !== actionA.id),
      runtime,
    );

    expect(result).toEqual({
      status: 'committed',
      queue: [expect.objectContaining({ id: actionB.id })],
    });
    expect(JSON.parse(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`)!))
      .toEqual([expect.objectContaining({ id: actionB.id })]);
  });

  it('surfaces protected handoff rejection distinctly from storage failure', async () => {
    const runtime = createRuntime([]);
    const action = {
      ...createQueuedAction('protected-action'),
      syncState: 'held',
      localHandoff: {
        kind: 'resolved-project-conflict',
        state: 'required',
        ownerUserId: 'user-a',
        projectId: 'project-1',
        actionId: 'protected-action',
        operationId: 'operation-protected-action',
        payloadDigest: 'payload-digest',
        conflictFingerprint: 'conflict-fingerprint',
      },
    } as unknown as QueuedAction;
    queueBackupService.updateQueueStrictly.mockResolvedValueOnce({
      status: 'protected-handoff',
      reason: 'required',
      actionIds: [action.id],
    });
    queueBackupService.updateQueue.mockResolvedValueOnce(null);

    await expect(service.persistQueueMutationForOwner(
      'user-a',
      () => [],
      runtime,
    )).rejects.toMatchObject({
      name: 'ProtectedQueueMutationError',
      reason: 'required',
      actionIds: [action.id],
    });
  });

  it('does not stage dead-letter evidence before an incomplete handoff is rejected', async () => {
    const runtime = createRuntime([]);
    const action = createProtectedAction('protected-terminal', 'required');
    queueBackupService.restoreQueue.mockResolvedValueOnce([action]);
    queueBackupService.updateQueueStrictly.mockResolvedValueOnce({
      status: 'protected-handoff',
      reason: 'required',
      actionIds: [action.id],
    });

    await expect(service.settleFailedActionForOwner(
      'user-a',
      action,
      terminalBusinessError(),
      runtime,
    )).rejects.toMatchObject({ name: 'ProtectedQueueMutationError', reason: 'required' });

    expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`)).toBeNull();
    expect(queueBackupService.backupDeadLetters).not.toHaveBeenCalled();
  });

  it('persists complete-handoff authorization before staging dead-letter evidence', async () => {
    const runtime = createRuntime([]);
    const action = createProtectedAction('complete-terminal', 'complete');
    const events: string[] = [];
    let durableQueue = [action];
    queueBackupService.restoreQueue.mockResolvedValueOnce(durableQueue);
    queueBackupService.updateQueueStrictly
      .mockImplementationOnce(async (_ownerUserId, updater) => {
        durableQueue = updater(durableQueue, { recordFound: true });
        events.push('authorization-committed');
        return { status: 'committed', queue: durableQueue };
      })
      .mockImplementationOnce(async (_ownerUserId, updater) => {
        events.push('removal-started');
        durableQueue = updater(durableQueue, { recordFound: true });
        return { status: 'committed', queue: durableQueue };
      });
    queueBackupService.backupDeadLetters.mockImplementationOnce(async () => {
      events.push('dead-letter-staged');
      return true;
    });

    await expect(service.settleFailedActionForOwner(
      'user-a',
      action,
      terminalBusinessError(),
      runtime,
    )).resolves.toBe('dead-letter');

    expect(events).toEqual([
      'authorization-committed',
      'dead-letter-staged',
      'removal-started',
    ]);
    expect(durableQueue).toEqual([]);
  });

  it('does not resurrect a locally removed action from a stale backup after refresh', async () => {
    const action = createQueuedAction('removed-before-backup-commit');
    const storageKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
    localStorage.setItem(storageKey, JSON.stringify([action]));
    queueBackupService.backupQueue.mockReturnValueOnce(new Promise<boolean>(() => {}));
    queueBackupService.restoreQueueSnapshot.mockResolvedValueOnce({
      recordFound: true,
      actions: [action],
      savedAt: new Date(action.timestamp).toISOString(),
    });

    service.saveCurrentQueueToStorage(createRuntime([]));

    const restoredQueue = signal<QueuedAction[]>([]);
    const restoredRuntime = createRuntime([]);
    restoredRuntime.pendingActions = () => restoredQueue();
    restoredRuntime.setPendingActions = vi.fn(queue => restoredQueue.set(queue));

    await service.loadCurrentQueueFromStorage(1, 'user-a', () => 1, restoredRuntime);

    expect(restoredQueue()).toEqual([]);
  });

  it('preserves a different operation added by another tab while filtering a stale removal', async () => {
    const removedAction = createQueuedAction('removed-in-this-tab');
    const otherTabAction = createQueuedAction('added-in-other-tab');
    removedAction.operationId = '11111111-1111-4111-8111-111111111111';
    otherTabAction.operationId = '22222222-2222-4222-8222-222222222222';
    const storageKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
    localStorage.setItem(storageKey, JSON.stringify([removedAction]));
    queueBackupService.backupQueue.mockReturnValueOnce(new Promise<boolean>(() => {}));
    queueBackupService.restoreQueueSnapshot.mockResolvedValueOnce({
      recordFound: true,
      actions: [removedAction, otherTabAction],
      savedAt: new Date(otherTabAction.timestamp).toISOString(),
    });

    service.saveCurrentQueueToStorage(createRuntime([]));

    const restoredQueue = signal<QueuedAction[]>([]);
    const restoredRuntime = createRuntime([]);
    restoredRuntime.pendingActions = () => restoredQueue();
    restoredRuntime.setPendingActions = vi.fn(queue => restoredQueue.set(queue));

    await service.loadCurrentQueueFromStorage(1, 'user-a', () => 1, restoredRuntime);

    expect(restoredQueue()).toEqual([otherTabAction]);
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

function createDeadLetter(id: string): DeadLetterItem {
  return {
    action: createQueuedAction(`action-${id}`),
    failedAt: '2026-08-03T00:00:00.000Z',
    reason: 'test failure',
  };
}

function createProtectedAction(
  id: string,
  state: 'required' | 'reserved' | 'effects-applied' | 'complete',
): QueuedAction {
  const action = {
    ...createQueuedAction(id),
    operationId: '77777777-7777-4777-8777-777777777777',
  };
  return {
    ...action,
    entityType: 'project',
    entityId: 'project-1',
    syncState: 'held',
    localHandoff: {
      kind: 'resolved-project-conflict',
      state,
      ownerUserId: 'user-a',
      projectId: 'project-1',
      actionId: action.id,
      operationId: action.operationId,
      payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint',
    },
  };
}

function terminalBusinessError() {
  return {
    message: 'operation identity mismatch',
    details: { reason: 'operation_id_payload_mismatch' },
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
