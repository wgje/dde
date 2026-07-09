import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusConsoleSyncService } from './focus-console-sync.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { AuthService } from '../../../../services/auth.service';
import { LoggerService } from '../../../../services/logger.service';
import { SessionManagerService } from './session-manager.service';
import { SyncRpcClientService } from '../../../../services/sync-rpc-client.service';
import { DataSafetyAuditPersistence } from '../../../../services/data-safety-audit-persistence';
import {
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../../../../utils/browser-network-suspension';
import { registerFocusConsoleRoutineSyncSpecs } from './focus-console-sync.service.spec-helpers';

describe('FocusConsoleSyncService', () => {
  let service: FocusConsoleSyncService;
  const mockClient = {
    from: vi.fn(),
    rpc: vi.fn(),
  };

  const mockSupabaseClientService = {
    isConfigured: true,
    client: vi.fn(() => mockClient),
  };

  const mockAuthService = {
    currentUserId: vi.fn(() => 'user-1'),
    sessionInitialized: vi.fn(() => true),
    authState: vi.fn(() => ({ isCheckingSession: false })),
    runtimeState: vi.fn(() => 'ready'),
    peekPersistedSessionIdentity: vi.fn(() => ({ userId: 'user-1' })),
  };

  const mockSessionManager = {
    isSessionExpiredError: vi.fn(() => false),
    tryRefreshSessionWithSession: vi.fn().mockResolvedValue({ refreshed: false }),
  };

  const mockSyncRpc = {
    isFeatureEnabled: vi.fn(() => true),
    isClientRejected: vi.fn(() => false),
    upsertFocusSession: vi.fn().mockResolvedValue({
      status: 'applied',
      raw: {},
    }),
    upsertRoutineTask: vi.fn().mockResolvedValue({
      status: 'applied',
      raw: {},
    }),
    incrementRoutineCompletion: vi.fn().mockResolvedValue({
      status: 'applied',
      raw: {},
    }),
  };

  const mockLoggerCategory = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };

  const mockLogger = {
    category: vi.fn(() => mockLoggerCategory),
  };

  const setVisibilityState = (state: DocumentVisibilityState): void => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: state,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.from.mockReset();
    mockClient.rpc.mockReset();
    mockSupabaseClientService.client.mockClear();
    mockSupabaseClientService.isConfigured = true;
    mockAuthService.currentUserId.mockClear();
    mockAuthService.sessionInitialized.mockClear();
    mockAuthService.authState.mockClear();
    mockAuthService.runtimeState.mockClear();
    mockAuthService.peekPersistedSessionIdentity.mockClear();
    mockSessionManager.isSessionExpiredError.mockClear();
    mockSessionManager.tryRefreshSessionWithSession.mockClear();
    mockSyncRpc.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpc.isClientRejected.mockReturnValue(false);
    mockSyncRpc.upsertFocusSession.mockResolvedValue({
      status: 'applied',
      raw: {},
    });
    mockSyncRpc.upsertRoutineTask.mockResolvedValue({
      status: 'applied',
      raw: {},
    });
    mockSyncRpc.incrementRoutineCompletion.mockResolvedValue({
      status: 'applied',
      raw: {},
    });
    new DataSafetyAuditPersistence().save('user-1', { replayLog: [], lastWriteExplain: null });
    resetBrowserNetworkSuspensionTrackingForTests();
    ensureBrowserNetworkSuspensionTracking();
    setVisibilityState('visible');

    TestBed.configureTestingModule({
      providers: [
        FocusConsoleSyncService,
        { provide: SupabaseClientService, useValue: mockSupabaseClientService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: SessionManagerService, useValue: mockSessionManager },
        { provide: LoggerService, useValue: mockLogger },
        { provide: SyncRpcClientService, useValue: mockSyncRpc },
      ],
    });

    service = TestBed.inject(FocusConsoleSyncService);
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
  });

  it('loadFocusSession should use updated_at desc + limit(1) for LWW latest snapshot', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'session-1',
        user_id: 'user-1',
        started_at: '2026-03-03T00:00:00.000Z',
        ended_at: null,
        updated_at: '2026-03-03T01:00:00.000Z',
        session_state: {
          version: 6,
          entries: [
            {
              taskId: 'dock-created',
              sourceProjectId: null,
            },
          ],
        },
      },
      error: null,
    });
    const limit = vi.fn(() => ({ maybeSingle }));
    const order = vi.fn(() => ({ limit }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    mockClient.from.mockReturnValue({ select });

    const result = await service.loadFocusSession('user-1');

    expect(result.ok).toBe(true);
    expect(order).toHaveBeenCalledWith('updated_at', { ascending: false });
    expect(limit).toHaveBeenCalledWith(1);
    if (result.ok) {
      expect((result.value as { entries?: Array<{ sourceProjectId: string | null }> } | null)?.entries?.[0]?.sourceProjectId)
        .toBeNull();
    }
  });

  it('loadFocusSession should reuse inflight request even when debug logger fails', async () => {
    let resolveMaybeSingle!: (value: {
      data: null;
      error: null;
    }) => void;
    const maybeSingle = vi.fn(() => new Promise<{ data: null; error: null }>(resolve => {
      resolveMaybeSingle = resolve;
    }));
    const limit = vi.fn(() => ({ maybeSingle }));
    const order = vi.fn(() => ({ limit }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    mockClient.from.mockReturnValue({ select });

    const first = service.loadFocusSession('user-1');
    mockLoggerCategory.debug.mockImplementationOnce(() => {
      throw new Error('debug sink failed');
    });
    const second = service.loadFocusSession('user-1');

    resolveMaybeSingle({ data: null, error: null });

    await expect(first).resolves.toEqual({ ok: true, value: null });
    await expect(second).resolves.toEqual({ ok: true, value: null });
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('saveFocusSession should reject missing operationId before legacy REST write', async () => {
    const result = await service.saveFocusSession({
      id: 'session-1',
      userId: 'user-1',
      startedAt: '2026-03-03T00:00:00.000Z',
      endedAt: null,
      updatedAt: '2026-03-03T01:00:00.000Z',
      snapshot: {
        version: 6,
        entries: [],
        focusMode: true,
        isDockExpanded: true,
        muteWaitTone: false,
        session: {
          firstDragIntervened: true,
          focusBlurOn: true,
          focusScrimOn: true,
          mainTaskId: null,
          comboSelectIds: [],
          backupIds: [],
        },
        dailySlots: [],
        suspendChainRootTaskId: null,
        suspendRecommendationLocked: false,
        pendingDecision: null,
        lastRuleDecision: null,
        dailyResetDate: '2026-03-03',
        savedAt: '2026-03-03T01:00:00.000Z',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOCUS_CONSOLE_SAVE_FAILED');
      expect(result.error.details?.['reason']).toBe('missing-operation-id');
    }
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('saveFocusSession should return deferred failure when warning logger fails', async () => {
    mockLoggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn sink failed');
    });

    await expect(service.saveFocusSession({
      id: 'session-logger-failure',
      userId: 'user-1',
      startedAt: '2026-03-03T00:00:00.000Z',
      endedAt: null,
      updatedAt: '2026-03-03T01:00:00.000Z',
      snapshot: {
        version: 6,
        entries: [],
        focusMode: true,
        isDockExpanded: true,
        muteWaitTone: false,
        session: {
          firstDragIntervened: true,
          focusBlurOn: true,
          focusScrimOn: true,
          mainTaskId: null,
          comboSelectIds: [],
          backupIds: [],
        },
        dailySlots: [],
        suspendChainRootTaskId: null,
        suspendRecommendationLocked: false,
        pendingDecision: null,
        lastRuleDecision: null,
        dailyResetDate: '2026-03-03',
        savedAt: '2026-03-03T01:00:00.000Z',
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'FOCUS_CONSOLE_SAVE_FAILED',
        details: {
          reason: 'missing-operation-id',
        },
      },
    });
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('saveFocusSession should not run legacy freshness/read path when operationId is missing', async () => {
    const result = await service.saveFocusSession({
      id: 'session-1',
      userId: 'user-1',
      startedAt: '2026-03-03T00:00:00.000Z',
      endedAt: null,
      updatedAt: '2026-03-03T01:00:00.000Z',
      snapshot: {
        version: 7,
        entries: [],
        focusMode: true,
        isDockExpanded: true,
        muteWaitTone: false,
        session: {
          firstDragIntervened: true,
          focusBlurOn: true,
          focusScrimOn: true,
          mainTaskId: 'A',
          comboSelectIds: ['B', 'C', 'D'],
          backupIds: [],
        },
        dailySlots: [],
        suspendChainRootTaskId: null,
        suspendRecommendationLocked: false,
        pendingDecision: null,
        lastRuleDecision: null,
        dailyResetDate: '2026-03-03',
        savedAt: '2026-03-03T01:00:00.000Z',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.['reason']).toBe('missing-operation-id');
    }
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('saveFocusSession should use Sync RPC when operationId is provided', async () => {
    const record = {
      id: 'session-1',
      userId: 'user-1',
      startedAt: '2026-03-03T00:00:00.000Z',
      endedAt: null,
      updatedAt: '2026-03-03T01:00:00.000Z',
      snapshot: {
        version: 6,
        entries: [],
        focusMode: true,
        isDockExpanded: true,
        muteWaitTone: false,
        session: {
          firstDragIntervened: true,
          focusBlurOn: true,
          focusScrimOn: true,
          mainTaskId: null,
          comboSelectIds: [],
          backupIds: [],
        },
        dailySlots: [],
        suspendChainRootTaskId: null,
        suspendRecommendationLocked: false,
        pendingDecision: null,
        lastRuleDecision: null,
        dailyResetDate: '2026-03-03',
        savedAt: '2026-03-03T01:00:00.000Z',
      },
    };

    const result = await service.saveFocusSession(record, 'op-focus-session');

    expect(result.ok).toBe(true);
    expect(mockSyncRpc.upsertFocusSession).toHaveBeenCalledWith({
      operationId: 'op-focus-session',
      record,
    });
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('saveFocusSession should fail when Sync RPC keeps remote state for stale payload', async () => {
    mockSyncRpc.upsertFocusSession.mockResolvedValueOnce({
      status: 'applied',
      stalePayload: true,
      reason: 'remote-newer-payload-preserved',
      raw: {},
    });
    const record = {
      id: 'session-stale',
      userId: 'user-1',
      startedAt: '2026-03-03T00:00:00.000Z',
      endedAt: null,
      updatedAt: '2026-03-03T01:00:00.000Z',
      snapshot: {
        version: 6,
        entries: [],
        focusMode: true,
        isDockExpanded: true,
        muteWaitTone: false,
        session: {
          firstDragIntervened: true,
          focusBlurOn: true,
          focusScrimOn: true,
          mainTaskId: null,
          comboSelectIds: [],
          backupIds: [],
        },
        dailySlots: [],
        suspendChainRootTaskId: null,
        suspendRecommendationLocked: false,
        pendingDecision: null,
        lastRuleDecision: null,
        dailyResetDate: '2026-03-03',
        savedAt: '2026-03-03T01:00:00.000Z',
      },
    };

    const result = await service.saveFocusSession(record, 'op-focus-session-stale');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOCUS_CONSOLE_SAVE_FAILED');
      expect(result.error.details?.['reason']).toBe('stale-payload-preserved-remotely');
    }
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('saveFocusSession should persist write explain and replay entry after Sync RPC applies', async () => {
    mockSyncRpc.upsertFocusSession.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-06-15T03:00:00.000Z',
      raw: {},
    });
    const record = {
      id: 'session-audit',
      userId: 'user-1',
      startedAt: '2026-03-03T00:00:00.000Z',
      endedAt: null,
      updatedAt: '2026-03-03T01:00:00.000Z',
      snapshot: {
        version: 6,
        entries: [],
        focusMode: true,
        isDockExpanded: true,
        muteWaitTone: false,
        session: {
          firstDragIntervened: true,
          focusBlurOn: true,
          focusScrimOn: true,
          mainTaskId: null,
          comboSelectIds: [],
          backupIds: [],
        },
        dailySlots: [],
        suspendChainRootTaskId: null,
        suspendRecommendationLocked: false,
        pendingDecision: null,
        lastRuleDecision: null,
        dailyResetDate: '2026-03-03',
        savedAt: '2026-03-03T01:00:00.000Z',
      },
    };

    const result = await service.saveFocusSession(record, 'op-focus-session-audit');

    expect(result.ok).toBe(true);
    const audit = new DataSafetyAuditPersistence().load('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId: 'op-focus-session-audit',
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'focus-session', id: 'session-audit' },
      operation: 'upsert',
      updatedAtBaseline: '2026-03-03T01:00:00.000Z',
      beforeVersion: '2026-03-03T01:00:00.000Z',
      afterVersion: '2026-06-15T03:00:00.000Z',
      queueResult: { enteredRetryQueue: false, retryCount: 0 },
      rpcResult: { status: 'applied', serverUpdatedAt: '2026-06-15T03:00:00.000Z' },
      lwwDecision: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
    expect(audit.replayLog[0]).toMatchObject({
      operationId: 'op-focus-session-audit',
      entityType: 'focus-session',
      entityId: 'session-audit',
      operation: 'upsert',
      baseUpdatedAt: '2026-03-03T01:00:00.000Z',
      rpc: { status: 'applied', serverUpdatedAt: '2026-06-15T03:00:00.000Z' },
      lww: { decision: 'local-applied', reason: 'applied' },
    });
  });

  it('saveFocusSession should fail instead of legacy upserting when operationId is missing', async () => {
    const result = await service.saveFocusSession({
      id: 'session-1',
      userId: 'user-1',
      startedAt: '2026-03-03T00:00:00.000Z',
      endedAt: null,
      updatedAt: '2026-03-03T01:00:00.000Z',
      snapshot: {
        version: 6,
        entries: [],
        focusMode: true,
        isDockExpanded: true,
        muteWaitTone: false,
        session: {
          firstDragIntervened: true,
          focusBlurOn: true,
          focusScrimOn: true,
          mainTaskId: null,
          comboSelectIds: [],
          backupIds: [],
        },
        dailySlots: [],
        suspendChainRootTaskId: null,
        suspendRecommendationLocked: false,
        pendingDecision: null,
        lastRuleDecision: null,
        dailyResetDate: '2026-03-03',
        savedAt: '2026-03-03T01:00:00.000Z',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOCUS_CONSOLE_SAVE_FAILED');
      expect(result.error.details?.['reason']).toBe('missing-operation-id');
    }
    expect(mockSyncRpc.upsertFocusSession).not.toHaveBeenCalled();
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('saveFocusSession should defer remote write during browser suspension window', async () => {
    setVisibilityState('hidden');

    const result = await service.saveFocusSession({
      id: 'session-1',
      userId: 'user-1',
      startedAt: '2026-03-03T00:00:00.000Z',
      endedAt: null,
      updatedAt: '2026-03-03T01:00:00.000Z',
      snapshot: {
        version: 6,
        entries: [],
        focusMode: true,
        isDockExpanded: true,
        muteWaitTone: false,
        session: {
          firstDragIntervened: true,
          focusBlurOn: true,
          focusScrimOn: true,
          mainTaskId: null,
          comboSelectIds: [],
          backupIds: [],
        },
        dailySlots: [],
        suspendChainRootTaskId: null,
        suspendRecommendationLocked: false,
        pendingDecision: null,
        lastRuleDecision: null,
        dailyResetDate: '2026-03-03',
        savedAt: '2026-03-03T01:00:00.000Z',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SYNC_OFFLINE');
      expect(result.error.details?.['reason']).toBe('browser-network-suspended');
    }
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('loadFocusSession should return success(null) when Supabase is not configured (offline fallback)', async () => {
    mockSupabaseClientService.isConfigured = false;

    const result = await service.loadFocusSession('user-1');

    // 离线时返回 success(null)，让调用方使用本地数据
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
    expect(mockSupabaseClientService.client).not.toHaveBeenCalled();
    mockSupabaseClientService.isConfigured = true;
  });

  it('loadFocusSession should skip remote read during browser suspension window', async () => {
    setVisibilityState('hidden');

    const result = await service.loadFocusSession('user-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SYNC_OFFLINE');
      expect(result.error.details?.['reason']).toBe('browser-network-suspended');
    }
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  registerFocusConsoleRoutineSyncSpecs({
    service: () => service,
    mockClient,
    mockSyncRpc,
  });
});
