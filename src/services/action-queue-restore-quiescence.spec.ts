import { runInInjectionContext, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDestroyRef } from '../test-setup.mocks';
import { deleteDataSafetyRestoreMarkerJournalDatabaseForTests } from './data-safety-restore-marker-journal';
import {
  getLocalBackupUiRestoreQuiescenceSentinelStorageKey,
  LocalBackupUiRestoreWriterPausedError,
  localBackupUiRestoreWriterQuiescence,
} from './local-backup-ui-restore-writer-quiescence.service';
import { readActiveLocalBackupUiRestoreWriters } from './local-backup-ui-restore-writer-quiescence-tracker';
import type {
  LocalBackupUiRestorePreActionQueueFenceInput,
  LocalBackupUiRestorePreActionQueueFenceResult,
} from './local-backup-ui-restore-pre-actionqueue-fence.service';
import { ActionQueueService } from './action-queue.service';
import { ActionQueueStorageService } from './action-queue-storage.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import {
  createActionQueueServiceTestInjector,
  createMockProject,
  mockLocalBackupUiRestorePreActionQueueFence,
  mockQueueBackupService,
  mockRetryQueueService,
  resetActionQueueServiceMocks,
} from './action-queue-service-test-harness.spec-helpers';
import { installWindowEventBridge } from './action-queue-dom-event-bridge.spec-helpers';

describe('ActionQueue restore writer quiescence', () => {
  let service: ActionQueueService;
  let destroy: () => void;
  let restoreWindowEvents: () => void;
  let loadQueueFromStorageSpy: ReturnType<typeof vi.spyOn>;
  let loadDeadLetterFromStorageSpy: ReturnType<typeof vi.spyOn>;
  let setupNetworkListenersSpy: ReturnType<typeof vi.spyOn>;
  let currentUserId: ReturnType<typeof signal<string | null>>;

  beforeEach(async () => {
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
    resetActionQueueServiceMocks();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    loadQueueFromStorageSpy = vi.spyOn(ActionQueueStorageService.prototype, 'loadQueueFromStorage');
    loadDeadLetterFromStorageSpy = vi.spyOn(
      ActionQueueStorageService.prototype,
      'loadDeadLetterFromStorage',
    );
    setupNetworkListenersSpy = vi.spyOn(
      ActionQueueStorageService.prototype,
      'setupNetworkListeners',
    );
    restoreWindowEvents = installWindowEventBridge();
    const destroyRef = createMockDestroyRef();
    destroy = destroyRef.destroy;
    currentUserId = signal<string | null>('test-user');
    const injector = createActionQueueServiceTestInjector(currentUserId, destroyRef.destroyRef);
    service = runInInjectionContext(injector, () => injector.get(ActionQueueService));
  });

  afterEach(async () => {
    service.reset();
    destroy();
    restoreWindowEvents();
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
  });

  it('constructs without loading owner storage, listeners, or RetryQueue integration', () => {
    expect(loadQueueFromStorageSpy).not.toHaveBeenCalled();
    expect(loadDeadLetterFromStorageSpy).not.toHaveBeenCalled();
    expect(setupNetworkListenersSpy).not.toHaveBeenCalled();
    expect(mockRetryQueueService.configureActionQueueSupersessionBridge).not.toHaveBeenCalled();
    expect(service.getCurrentOwnerStorageLoadState()).toBe('unknown');
    expect(service.pendingActions()).toEqual([]);
    expect(service.deadLetterQueue()).toEqual([]);
  });

  it('activates only after fence, detached staging, publication, and loaded state', async () => {
    const events: string[] = [];
    mockLocalBackupUiRestorePreActionQueueFence.run.mockImplementationOnce(async input => {
      events.push('fence');
      expect(input.isCurrent()).toBe(true);
      return {
        status: 'CLEAR', ownerUserId: input.ownerUserId,
        recovered: false, terminalResultDigest: null,
      };
    });
    mockQueueBackupService.restoreQueueSnapshot.mockImplementationOnce(async () => {
      events.push('queue-stage');
      return { recordFound: true, actions: [], savedAt: null };
    });
    mockQueueBackupService.restoreDeadLetters.mockImplementationOnce(async () => {
      events.push('dead-stage');
      return [];
    });
    mockRetryQueueService.configureActionQueueSupersessionBridge.mockImplementationOnce(() => {
      expect(service.getCurrentOwnerStorageLoadState()).toBe('loaded');
      events.push('retry-bridge');
    });
    setupNetworkListenersSpy.mockImplementationOnce(() => {
      expect(service.getCurrentOwnerStorageLoadState()).toBe('loaded');
      events.push('listeners');
    });
    vi.spyOn(service.storage, 'requestQueueProcessing').mockImplementationOnce(() => {
      expect(service.getCurrentOwnerStorageLoadState()).toBe('loaded');
      events.push('processing');
    });

    await service.reloadFromStorageForCurrentOwner();

    expect(events).toEqual([
      'fence', 'queue-stage', 'dead-stage', 'retry-bridge', 'listeners', 'processing',
    ]);
  });

  it('keeps queue loading unknown and performs zero storage activation on fence HOLD', async () => {
    mockLocalBackupUiRestorePreActionQueueFence.run.mockResolvedValueOnce({
      status: 'HOLD', ownerUserId: 'test-user', reason: 'RECOVERY_BLOCKED',
    });

    await service.reloadFromStorageForCurrentOwner();

    expect(service.getCurrentOwnerStorageLoadState()).toBe('unknown');
    expect(mockQueueBackupService.restoreQueueSnapshot).not.toHaveBeenCalled();
    expect(mockQueueBackupService.restoreDeadLetters).not.toHaveBeenCalled();
    expect(mockRetryQueueService.configureActionQueueSupersessionBridge).not.toHaveBeenCalled();
    expect(setupNetworkListenersSpy).not.toHaveBeenCalled();
  });

  it('keeps a failed owner reload inert after the caller continues', async () => {
    const oldQueue = [createQueuedAction('old')];
    const oldDeadLetters = [createDeadLetter('old')];
    service.pendingActions.set(oldQueue);
    service.queueSize.set(oldQueue.length);
    service.storage.deadLetterQueue.set(oldDeadLetters);
    service.storage.deadLetterSize.set(oldDeadLetters.length);
    const legacyQueue = JSON.stringify([createQueuedAction('legacy')]);
    const legacyDeadLetters = JSON.stringify([createDeadLetter('legacy')]);
    localStorage.setItem('nanoflow.action-queue', legacyQueue);
    localStorage.setItem('nanoflow.dead-letter-queue', legacyDeadLetters);
    const setItem = vi.spyOn(localStorage, 'setItem');
    const removeItem = vi.spyOn(localStorage, 'removeItem');
    mockQueueBackupService.restoreQueueSnapshot.mockResolvedValueOnce({
      recordFound: false, actions: [], savedAt: null,
    });
    mockQueueBackupService.restoreDeadLetters.mockRejectedValueOnce(new Error('owner reload failed'));

    await expect(service.reloadFromStorageForCurrentOwner()).resolves.toBeUndefined();
    expect(service.getCurrentOwnerStorageLoadState()).toBe('unknown');

    const saveQueue = vi.spyOn(service.storage, 'saveQueueToStorage');
    const saveDeadLetters = vi.spyOn(service.storage, 'saveDeadLetterToStorage');
    const persistQueue = vi.spyOn(service.storage, 'persistQueueMutationForOwner');
    const persistQueueStrictly = vi.spyOn(service.storage, 'persistQueueMutationStrictlyForOwner');
    const action = {
      type: 'update' as const,
      entityType: 'project' as const,
      entityId: 'project-blocked',
      payload: { project: createMockProject({ id: 'project-blocked' }) },
    };

    expect(() => service.enqueue(action)).toThrow(/owner storage.*unknown/i);
    await expect(service.enqueueDurably(action)).rejects.toThrow(/owner storage.*unknown/i);
    await expect(service.enqueueManyDurably([action])).rejects.toThrow(/owner storage.*unknown/i);
    expect(() => service.dequeue(oldQueue[0].id)).toThrow(/owner storage.*unknown/i);
    await expect(service.processQueue()).rejects.toThrow(/owner storage.*unknown/i);
    expect(() => service.clearQueue()).toThrow(/owner storage.*unknown/i);
    expect(() => service.clearQueueForFullWipe()).toThrow(/owner storage.*unknown/i);
    expect(() => service.clearDeadLetterQueue()).toThrow(/owner storage.*unknown/i);
    await expect(service.retryDeadLetter(oldDeadLetters[0].action.id))
      .rejects.toThrow(/owner storage.*unknown/i);
    expect(() => service.dismissDeadLetter(oldDeadLetters[0].action.id))
      .toThrow(/owner storage.*unknown/i);
    expect(() => service.moveToDeadLetter(oldQueue[0], 'blocked owner reload'))
      .toThrow(/owner storage.*unknown/i);
    expect(() => service.discardActions(() => true)).toThrow(/owner storage.*unknown/i);

    expect(service.pendingActions()).toBe(oldQueue);
    expect(service.deadLetterQueue()).toBe(oldDeadLetters);
    expect(saveQueue).not.toHaveBeenCalled();
    expect(saveDeadLetters).not.toHaveBeenCalled();
    expect(persistQueue).not.toHaveBeenCalled();
    expect(persistQueueStrictly).not.toHaveBeenCalled();
    expect(mockQueueBackupService.backupQueue).not.toHaveBeenCalled();
    expect(mockQueueBackupService.backupDeadLetters).not.toHaveBeenCalled();
    expect(setupNetworkListenersSpy).not.toHaveBeenCalled();
    expect(mockRetryQueueService.configureActionQueueSupersessionBridge).not.toHaveBeenCalled();

    const ownerStorage = (service.storage as unknown as { ownerStorage: {
      saveCurrentQueueToStorage(): void;
      saveCurrentDeadLettersToStorage(): boolean;
    } }).ownerStorage;
    const saveCurrentQueue = vi.spyOn(ownerStorage, 'saveCurrentQueueToStorage');
    const saveCurrentDeadLetters = vi.spyOn(ownerStorage, 'saveCurrentDeadLettersToStorage');
    service.storage.saveQueueToStorage();
    expect(service.storage.saveDeadLetterToStorage()).toBe(false);
    expect(saveCurrentQueue).not.toHaveBeenCalled();
    expect(saveCurrentDeadLetters).not.toHaveBeenCalled();

    await expect(service.enqueueDurablyForOwner('foreign-user', {
      ...action, entityId: 'project-foreign',
      payload: { project: createMockProject({ id: 'project-foreign' }) },
    })).resolves.toEqual(expect.any(String));
    expect(persistQueue).toHaveBeenCalledWith('foreign-user', expect.any(Function));

    service.reset();
    expect(localStorage.getItem('nanoflow.action-queue')).toBe(legacyQueue);
    expect(localStorage.getItem('nanoflow.dead-letter-queue')).toBe(legacyDeadLetters);
    expect(localStorage.getItem('nanoflow.action-queue.legacy-review.__legacy_unknown__')).toBeNull();
    const queueStorageKeys = new Set([
      'nanoflow.action-queue', 'nanoflow.action-queue.test-user',
      'nanoflow.dead-letter-queue', 'nanoflow.dead-letter-queue.test-user',
      'nanoflow.action-queue.legacy-review.__legacy_unknown__',
    ]);
    expect(setItem.mock.calls.filter(([key]) => queueStorageKeys.has(key))).toEqual([]);
    expect(removeItem.mock.calls.filter(([key]) => queueStorageKeys.has(key))).toEqual([]);
  });

  it('allows only the newest A generation to load after an A to B to A fence race', async () => {
    const attempts: Array<{
      input: LocalBackupUiRestorePreActionQueueFenceInput;
      resolve: (result: LocalBackupUiRestorePreActionQueueFenceResult) => void;
    }> = [];
    mockLocalBackupUiRestorePreActionQueueFence.run.mockImplementation(input => new Promise(resolve => {
      attempts.push({ input, resolve });
    }));

    const firstA = service.reloadFromStorageForCurrentOwner();
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    currentUserId.set('user-b');
    const ownerB = service.reloadFromStorageForCurrentOwner();
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    currentUserId.set('test-user');
    const secondA = service.reloadFromStorageForCurrentOwner();
    await vi.waitFor(() => expect(attempts).toHaveLength(3));

    expect(attempts[0].input.ownerUserId).toBe('test-user');
    expect(attempts[0].input.isCurrent()).toBe(false);
    expect(attempts[1].input.isCurrent()).toBe(false);
    expect(attempts[2].input.isCurrent()).toBe(true);
    attempts[0].resolve({
      status: 'HOLD', ownerUserId: 'test-user', reason: 'OWNER_GENERATION_STALE',
    });
    attempts[1].resolve({
      status: 'HOLD', ownerUserId: 'user-b', reason: 'OWNER_GENERATION_STALE',
    });
    attempts[2].resolve({
      status: 'CLEAR', ownerUserId: 'test-user', recovered: false, terminalResultDigest: null,
    });
    await Promise.all([firstA, ownerB, secondA]);

    expect(mockQueueBackupService.restoreQueueSnapshot).toHaveBeenCalledTimes(1);
    expect(mockQueueBackupService.restoreDeadLetters).toHaveBeenCalledTimes(1);
    expect(service.getCurrentOwnerStorageLoadState()).toBe('loaded');
  });

  it('keeps the exact six-field preimage until queue and dead-letter staging both finish', async () => {
    const oldQueue = [createQueuedAction('old')];
    const oldDeadLetters = [createDeadLetter('old')];
    service.pendingActions.set(oldQueue);
    service.queueSize.set(oldQueue.length);
    service.storage.deadLetterQueue.set(oldDeadLetters);
    service.storage.deadLetterSize.set(oldDeadLetters.length);
    service.storage.queueFrozen.set(true);
    service.storage.queueFreezeReason.set('old-freeze');
    let releaseQueue!: (snapshot: {
      recordFound: boolean;
      actions: QueuedAction[];
      savedAt: null;
    }) => void;
    let releaseDeadLetters!: (queue: DeadLetterItem[]) => void;
    mockQueueBackupService.restoreQueueSnapshot.mockReturnValueOnce(new Promise(resolve => {
      releaseQueue = resolve;
    }));
    mockQueueBackupService.restoreDeadLetters.mockReturnValueOnce(new Promise(resolve => {
      releaseDeadLetters = resolve;
    }));

    const reload = service.reloadFromStorageForCurrentOwner();
    await vi.waitFor(() => expect(releaseQueue).toBeTypeOf('function'));
    releaseQueue({ recordFound: true, actions: [createQueuedAction('new')], savedAt: null });
    await vi.waitFor(() => expect(releaseDeadLetters).toBeTypeOf('function'));

    expect(service.pendingActions()).toBe(oldQueue);
    expect(service.queueSize()).toBe(1);
    expect(service.deadLetterQueue()).toBe(oldDeadLetters);
    expect(service.deadLetterSize()).toBe(1);
    expect(service.queueFrozen()).toBe(true);
    expect(service.queueFreezeReason()).toBe('old-freeze');
    expect(service.getCurrentOwnerStorageLoadState()).toBe('loading');

    releaseDeadLetters([createDeadLetter('new')]);
    await reload;
    expect(service.pendingActions().map(action => action.id)).toEqual(['action-new']);
    expect(service.deadLetterQueue().map(item => item.action.id)).toEqual(['action-dead-new']);
    expect(service.getCurrentOwnerStorageLoadState()).toBe('loaded');
  });

  it('rejects enqueue without changing the queue while the owner is frozen', async () => {
    const action = {
      type: 'update' as const,
      entityType: 'project' as const,
      entityId: 'project-1',
      payload: { project: createMockProject({ id: 'project-1' }) },
    };
    await service.reloadFromStorageForCurrentOwner();
    service.enqueue(action);
    const queuedAction = service.pendingActions()[0];
    const handle = await localBackupUiRestoreWriterQuiescence.prepare('test-user');

    expect(() => service.enqueue(action)).toThrow(LocalBackupUiRestoreWriterPausedError);
    await expect(service.enqueueDurably(action)).rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.dequeue(queuedAction.id)).toThrow(LocalBackupUiRestoreWriterPausedError);
    await expect(service.processQueue()).rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.clearQueue()).toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.clearQueueForFullWipe()).toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.clearDeadLetterQueue()).toThrow(LocalBackupUiRestoreWriterPausedError);
    await expect(service.retryDeadLetter('dead-letter-1'))
      .rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.dismissDeadLetter('dead-letter-1')).toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.moveToDeadLetter(queuedAction, 'restore freeze'))
      .toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(() => service.discardActions(() => true)).toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(service.pendingActions()).toEqual([queuedAction]);
    await handle.abortBeforeMutation();
  });

  it('blocks direct dead-letter restore before local and IndexedDB writes while the owner is frozen', async () => {
    await service.reloadFromStorageForCurrentOwner();
    const existing = createDeadLetter('existing');
    const restored = createDeadLetter('restored');
    const storageKey = 'nanoflow.dead-letter-queue.test-user';
    const existingSnapshot = JSON.stringify([existing]);
    localStorage.setItem(storageKey, existingSnapshot);
    service.storage.deadLetterQueue.set([existing]);
    service.storage.deadLetterSize.set(1);

    const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey('test-user');
    localStorage.setItem(sentinelKey, JSON.stringify({
      ownerUserId: 'test-user',
      runId: 'restore-run',
      state: 'quiesced',
    }));
    const setItem = vi.spyOn(localStorage, 'setItem');
    mockQueueBackupService.backupDeadLetters.mockClear();
    try {
      expect(() => service.storage.restoreDeadLettersFromBackupItems([restored], 'test-user'))
        .toThrow(LocalBackupUiRestoreWriterPausedError);
      expect(localStorage.getItem(storageKey)).toBe(existingSnapshot);
      expect(setItem.mock.calls.filter(([key]) => key === storageKey)).toEqual([]);
      expect(mockQueueBackupService.backupDeadLetters).not.toHaveBeenCalled();
      expect(service.deadLetterQueue()).toEqual([existing]);
      expect(readActiveLocalBackupUiRestoreWriters('test-user')).toEqual([]);
    } finally {
      localStorage.removeItem(sentinelKey);
    }
  });

  it('blocks beforeunload queue mirror saves once restore quiescence starts', async () => {
    await service.reloadFromStorageForCurrentOwner();
    service.pendingActions.set([createQueuedAction('before-unload')]);
    service.queueSize.set(1);
    service.storage.deadLetterQueue.set([createDeadLetter('before-unload')]);
    service.storage.deadLetterSize.set(1);

    const ownerStorage = (service.storage as unknown as { ownerStorage: {
      saveCurrentQueueToStorage(): void;
      saveCurrentDeadLettersToStorage(): boolean;
    } }).ownerStorage;
    const saveQueue = vi.spyOn(ownerStorage, 'saveCurrentQueueToStorage');
    const saveDeadLetters = vi.spyOn(ownerStorage, 'saveCurrentDeadLettersToStorage');

    let releaseWriter!: () => void;
    let markWriterStarted!: () => void;
    const writerStarted = new Promise<void>(resolve => {
      markWriterStarted = resolve;
    });
    const activeWriter = localBackupUiRestoreWriterQuiescence.runAsync(
      'test-user',
      'action-queue',
      async () => {
        markWriterStarted();
        await new Promise<void>(resolve => {
          releaseWriter = resolve;
        });
      },
    );
    await writerStarted;

    const preparing = localBackupUiRestoreWriterQuiescence.prepare('test-user');
    try {
      await vi.waitFor(() => {
        const raw = localStorage.getItem(
          getLocalBackupUiRestoreQuiescenceSentinelStorageKey('test-user'),
        );
        expect(raw).toContain('"state":"pausing"');
      });

      expect(() => service.storage.saveQueueToStorage())
        .toThrow(LocalBackupUiRestoreWriterPausedError);
      expect(() => service.storage.saveDeadLetterToStorage())
        .toThrow(LocalBackupUiRestoreWriterPausedError);
      expect(saveQueue).not.toHaveBeenCalled();
      expect(saveDeadLetters).not.toHaveBeenCalled();
    } finally {
      releaseWriter();
      await activeWriter;
      const handle = await preparing;
      await handle.abortBeforeMutation();
    }
  });

  it('keeps prepare pending until an asynchronous owner queue restore finishes', async () => {
    let releaseRestore!: (snapshot: { recordFound: boolean; actions: []; savedAt: null }) => void;
    mockQueueBackupService.restoreQueueSnapshot.mockImplementationOnce(async () => (
      await new Promise(resolve => { releaseRestore = resolve; })
    ));
    service.reloadFromStorageForCurrentOwner();
    await vi.waitFor(() => expect(releaseRestore).toBeTypeOf('function'));
    let prepared = false;
    const preparing = localBackupUiRestoreWriterQuiescence.prepare('test-user').then(handle => {
      prepared = true;
      return handle;
    });

    await new Promise(resolve => setTimeout(resolve, 5));
    expect(prepared).toBe(false);
    releaseRestore({ recordFound: true, actions: [], savedAt: null });
    const handle = await preparing;
    await handle.abortBeforeMutation();
  });

  it('keeps prepare pending until the queue IndexedDB mirror settles', async () => {
    await service.reloadFromStorageForCurrentOwner();
    let releaseBackup!: (success: boolean) => void;
    mockQueueBackupService.backupQueue.mockImplementationOnce(async () => (
      await new Promise<boolean>(resolve => { releaseBackup = resolve; })
    ));
    service.enqueue({
      type: 'update',
      entityType: 'project',
      entityId: 'project-backup',
      payload: { project: createMockProject({ id: 'project-backup' }) },
    });
    await vi.waitFor(() => expect(releaseBackup).toBeTypeOf('function'));
    let prepared = false;
    const preparing = localBackupUiRestoreWriterQuiescence.prepare('test-user').then(handle => {
      prepared = true;
      return handle;
    });

    await new Promise(resolve => setTimeout(resolve, 5));
    expect(prepared).toBe(false);
    releaseBackup(true);
    const handle = await preparing;
    await handle.abortBeforeMutation();
  });

  it('keeps prepare pending until the dead-letter IndexedDB mirror settles', async () => {
    await service.reloadFromStorageForCurrentOwner();
    const actionId = service.enqueue({
      type: 'update',
      entityType: 'project',
      entityId: 'project-dead-letter',
      payload: { project: createMockProject({ id: 'project-dead-letter' }) },
    });
    const action = service.pendingActions().find(candidate => candidate.id === actionId)!;
    let releaseBackup!: (success: boolean) => void;
    mockQueueBackupService.backupDeadLetters.mockImplementationOnce(async () => (
      await new Promise<boolean>(resolve => { releaseBackup = resolve; })
    ));
    service.moveToDeadLetter(action, 'pending mirror');
    await vi.waitFor(() => expect(releaseBackup).toBeTypeOf('function'));
    let prepared = false;
    const preparing = localBackupUiRestoreWriterQuiescence.prepare('test-user').then(handle => {
      prepared = true;
      return handle;
    });

    await new Promise(resolve => setTimeout(resolve, 5));
    expect(prepared).toBe(false);
    releaseBackup(true);
    const handle = await preparing;
    await handle.abortBeforeMutation();
  });

  it('blocks durable writes scoped to a frozen foreign owner', async () => {
    const handle = await localBackupUiRestoreWriterQuiescence.prepare('foreign-owner');
    await expect(service.enqueueDurablyForOwner('foreign-owner', {
      type: 'update',
      entityType: 'project',
      entityId: 'foreign-project',
      payload: { project: createMockProject({ id: 'foreign-project' }) },
    })).rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    await handle.abortBeforeMutation();
  });
});

function createQueuedAction(id: string): QueuedAction {
  return {
    id: `action-${id}`,
    operationId: `operation-${id}`,
    type: 'update',
    entityType: 'project',
    entityId: `project-${id}`,
    payload: { project: createMockProject({ id: `project-${id}` }) },
    timestamp: 1,
    localCommittedAt: 1,
    retryCount: 0,
    priority: 'normal',
    syncState: 'pending_sync',
  };
}

function createDeadLetter(id: string): DeadLetterItem {
  return {
    action: createQueuedAction(`dead-${id}`),
    failedAt: '2026-08-03T00:00:00.000Z',
    reason: 'test failure',
  };
}
