import { Injector, runInInjectionContext, signal } from '@angular/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDestroyRef } from '../test-setup.mocks';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';
import { FocusConsoleSyncService } from '../app/core/services/sync/focus-console-sync.service';
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';
import { ActionQueueService } from './action-queue.service';
import { ActionQueueEnqueueMutationService } from './action-queue-enqueue-mutation.service';
import { ActionQueueSyncWriterLeaseService } from './action-queue-sync-writer-lease.service';
import { ActionQueueViewStateService } from './action-queue-view-state.service';
import { ActionQueueStorageService, LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';
import { ActionQueueOwnerStorageService } from './action-queue-owner-storage.service';
import { ActionQueueSchedulerService } from './action-queue-scheduler.service';
import { QueueBackupService } from './queue-backup.service';
import { AuthService } from './auth.service';
import { UserSessionService } from './user-session.service';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { SyncRpcClientService } from './sync-rpc-client.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import { buildService, installSyncRpcClientSpecEnv, syncRpcEnv } from './sync-rpc-client.service.spec-context';
import { createActionQueueServiceTestInjector, mockLoggerService,
  resetActionQueueServiceMocks, mockSyncWriterLeaseService } from './action-queue-service-test-harness.spec-helpers';
import { getProcessor, mockActionQueueService, mockAuthService, mockSyncService,
  setupActionQueueProcessorsHarness } from './action-queue-processors.spec-helpers';
import type { FocusSessionRecord } from '../models/parking-dock';

// Real RPC parser -> Focus result mapping -> registered Focus processor -> queue
// processing/storage -> actual IndexedDB reopen. Remote transport and unrelated
// external-service dependencies are synthetic; these queue/Focus runtime layers are real.
describe('Focus reconciliation-pending durable queue integration', () => {
  installSyncRpcClientSpecEnv();
  const owner = signal<string | null>('test-user');
  const queues: Array<{ service: ActionQueueService; destroy: () => void }> = [];
  const focusServices: FocusConsoleSyncService[] = [];

  function createQueue() {
    const destroyRef = createMockDestroyRef();
    const base = createActionQueueServiceTestInjector(owner, destroyRef.destroyRef);
    const injector = Injector.create({ parent: base, providers: [
      ActionQueueService, ActionQueueEnqueueMutationService, ActionQueueSyncWriterLeaseService,
      ActionQueueViewStateService, ActionQueueStorageService, ActionQueueOwnerStorageService,
      ActionQueueSchedulerService, QueueBackupService,
      { provide: AuthService, useValue: { currentUserId: owner,
        captureAuthIdentityFence: () => 'auth:' + owner() } },
      { provide: UserSessionService, useValue: { getCurrentSessionGeneration: () => 1,
        isSessionContextCurrent: (generation: number, userId: string) =>
          generation === 1 && userId === owner() } },
    ] });
    const service = runInInjectionContext(injector, () => injector.get(ActionQueueService));
    const entry = { service, destroy: destroyRef.destroy };
    queues.push(entry);
    return { ...entry, backup: injector.get(QueueBackupService) };
  }

  function attachFocusPipeline(queue: ActionQueueService, transport: (name: string, payload: unknown) =>
    Promise<{ data: unknown; error: null }>) {
    syncRpcEnv().syncRpcEnabled = true;
    const rpc = buildService((name, payload) => {
      const response = transport(name, payload);
      return Object.assign(response, { abortSignal: () => response });
    });
    const auth = { currentUserId: owner, sessionInitialized: () => true,
      authState: () => ({ isCheckingSession: false }), runtimeState: () => 'ready',
      peekPersistedSessionIdentity: () => ({ userId: owner() }) };
    const injector = Injector.create({ providers: [FocusConsoleSyncService,
      { provide: SyncRpcClientService, useValue: rpc },
      { provide: AuthService, useValue: auth },
      { provide: SupabaseClientService, useValue: { isConfigured: true, client: () => ({}) } },
      { provide: LoggerService, useValue: mockLoggerService },
      { provide: SessionManagerService, useValue: { isSessionExpiredError: () => false } },
      { provide: SessionRuntimeResetRegistry, useValue: { register: () => () => undefined } },
    ] });
    const focus = runInInjectionContext(injector, () => injector.get(FocusConsoleSyncService));
    focusServices.push(focus);
    setupActionQueueProcessorsHarness();
    mockAuthService.currentUserId.mockImplementation(() => owner());
    mockSyncService.saveFocusSession.mockImplementation(focus.saveFocusSession.bind(focus));
    const handler = getProcessor('focus-session:update');
    queue.registerProcessor('focus-session:update', handler);
  }

  function record(): FocusSessionRecord {
    return { id: '00000000-0000-4000-8000-00000000f001', userId: 'test-user',
      startedAt: '2026-01-01T00:00:00.000Z', endedAt: null,
      updatedAt: '2026-01-01T00:00:03.000Z', snapshot: {
        version: 6, savedAt: '2026-01-01T00:00:03.000Z', entries: [],
        focusMode: true, isDockExpanded: true, muteWaitTone: false,
        session: { firstDragIntervened: true, focusBlurOn: true, focusScrimOn: true,
          mainTaskId: null, comboSelectIds: [], backupIds: [] },
        dailySlots: [], suspendChainRootTaskId: null, suspendRecommendationLocked: false,
        pendingDecision: null, lastRuleDecision: null, dailyResetDate: '2026-01-01',
      } };
  }

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('indexedDB', new IDBFactory());
    resetBrowserNetworkSuspensionTrackingForTests();
    resetActionQueueServiceMocks();
    owner.set('test-user');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    for (const entry of queues.splice(0)) { entry.service.reset(); entry.destroy(); }
    for (const focus of focusServices.splice(0)) focus.ngOnDestroy();
    resetBrowserNetworkSuspensionTrackingForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not acknowledge/dead-letter unknown snapshots and preserves IDs and original payload across IDB reload and escape export', async () => {
    const first = createQueue();
    await first.service.reloadFromStorageForCurrentOwner();
    const transport = vi.fn(async () => ({ data: {
      status: 'reconciliation-pending', reason: 'snapshot-clock-unknown',
    }, error: null }));
    attachFocusPipeline(first.service, transport);
    const payload = { record: record(), sourceUserId: 'test-user' };
    const id = await first.service.enqueueDurably({ type: 'update', entityType: 'focus-session',
      entityId: payload.record.id, payload });
    expect(id).not.toBe('');
    const original = structuredClone(first.service.pendingActions()[0]);
    const atBudget = { ...original, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES };
    await first.service.storage.persistQueueSnapshotForOwner('test-user', [atBudget]);
    first.service.pendingActions.set([atBudget]);
    first.service.storage.isOnline = true;
    const outcome = await first.service.processQueue();
    expect(transport).toHaveBeenCalledOnce();
    expect(outcome.processed).toBe(0);
    expect(outcome.movedToDeadLetter).toBe(0);
    expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
    expect(first.service.storage.deadLetterQueue()).toEqual([]);
    expect(first.service.pendingActions()).toHaveLength(1);
    const pending = first.service.pendingActions()[0];
    expect(pending).toMatchObject({ id, operationId: original.operationId,
      payload, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES, syncState: 'retry_scheduled' });
    expect(pending.lastError).toContain('FOCUS_CONSOLE_SAVE_FAILED');
    const persisted = await first.backup.restoreQueue('test-user');
    expect(persisted).toEqual([pending]);

    first.service.reset(); first.destroy(); queues.splice(queues.findIndex(entry => entry.service === first.service), 1);
    // Prove this is not just a reread of the browser's localStorage mirror.
    localStorage.removeItem('nanoflow.action-queue.test-user');
    const reopened = createQueue();
    await reopened.service.reloadFromStorageForCurrentOwner();
    expect(reopened.service.pendingActions()).toEqual([pending]);
    expect(reopened.service.storage.deadLetterQueue()).toEqual([]);
    const exported = JSON.parse(reopened.service.storage.exportPendingActionsAsJson());
    expect(exported.metadata.source).toBe('action-queue-escape');
    expect(exported.pendingActions).toEqual([pending]);
    expect(exported.pendingActions[0]).toMatchObject({ id, operationId: original.operationId, payload });
    expect(exported.deadLetterQueue).toEqual([]);
    attachFocusPipeline(reopened.service, transport);
    reopened.service.storage.isOnline = true;
    await reopened.service.processQueue();
    // Reattaching the processor harness resets mock call history.
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]).toEqual(['sync_upsert_focus_session',
      expect.objectContaining({ operation_id: original.operationId,
        focus_session: expect.objectContaining({ session_state: payload.record.snapshot }) })]);
    expect(reopened.service.pendingActions()[0]).toMatchObject({ id,
      operationId: original.operationId, payload, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES,
      syncState: 'retry_scheduled' });
    expect(reopened.service.storage.deadLetterQueue()).toEqual([]);
    expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
  });

  it.each(['owner', 'lease', 'view-fence'] as const)('does not settle a delayed unknown response after %s context becomes stale', async cause => {
    const leaseController = new AbortController();
    if (cause === 'lease') {
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockResolvedValueOnce({
        tabId: 'focus-lease', lockName: 'focus-lease', mode: 'idb-lease',
        signal: leaseController.signal, release: vi.fn(async () => undefined),
      } as never);
    }
    const first = createQueue();
    await first.service.reloadFromStorageForCurrentOwner();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const started = new Promise<void>(resolve => { arrived = resolve; });
    const transport = vi.fn(async () => { arrived(); await gate; return {
      data: { status: 'reconciliation-pending', reason: 'snapshot-clock-unknown' }, error: null,
    }; });
    attachFocusPipeline(first.service, transport);
    const payload = { record: record(), sourceUserId: 'test-user' };
    const id = await first.service.enqueueDurably({ type: 'update', entityType: 'focus-session',
      entityId: payload.record.id, payload });
    const original = structuredClone(first.service.pendingActions()[0]);
    first.service.storage.isOnline = true;
    const processing = first.service.processQueue();
    await started;
    if (cause === 'owner') owner.set('other-user');
    else if (cause === 'lease') leaseController.abort();
    else first.service.clearCurrentView();
    release();
    await processing;
    expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
    const persisted = await first.backup.restoreQueue('test-user');
    expect(persisted).toHaveLength(1);
    expect(persisted?.[0]).toMatchObject({ id, operationId: original.operationId, payload,
      retryCount: original.retryCount });
    expect(await first.backup.restoreDeadLetters('test-user')).toEqual(null);
  });
});
