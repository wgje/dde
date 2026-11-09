import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { FocusSessionRecord, RoutineTask } from '../../../../models/parking-dock';

// 清偿 L-28 测试债：listRoutineTasks 成功映射、upsertRoutineTask 错误处理、
// saveFocusSession 成功路径、incrementRoutineCompletion 与 retry-queue 协同。
describe('FocusConsoleSyncService routine coverage (L-28)', () => {
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
    upsertFocusSession: vi.fn().mockResolvedValue({ status: 'applied', raw: {} }),
    upsertRoutineTask: vi.fn().mockResolvedValue({ status: 'applied', raw: {} }),
    incrementRoutineCompletion: vi.fn().mockResolvedValue({ status: 'applied', raw: {} }),
  };

  const mockLogger = {
    category: vi.fn(() => ({
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    })),
  };

  function createRoutineTask(overrides: Partial<RoutineTask> = {}): RoutineTask {
    return {
      routineId: 'routine-1',
      title: 'Routine',
      triggerCondition: 'any-blank-period',
      maxTimesPerDay: 2,
      isEnabled: true,
      updatedAt: '2026-06-15T00:00:02.000Z',
      ...overrides,
    };
  }

  function createFocusSessionRecord(): FocusSessionRecord {
    return {
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
    } as FocusSessionRecord;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.from.mockReset();
    mockClient.rpc.mockReset();
    mockSupabaseClientService.isConfigured = true;
    mockSyncRpc.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpc.isClientRejected.mockReturnValue(false);
    mockSyncRpc.upsertFocusSession.mockResolvedValue({ status: 'applied', raw: {} });
    mockSyncRpc.upsertRoutineTask.mockResolvedValue({ status: 'applied', raw: {} });
    mockSyncRpc.incrementRoutineCompletion.mockResolvedValue({ status: 'applied', raw: {} });
    new DataSafetyAuditPersistence().save('user-1', { replayLog: [], lastWriteExplain: null });
    resetBrowserNetworkSuspensionTrackingForTests();
    ensureBrowserNetworkSuspensionTracking();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

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
  });

  it('listRoutineTasks should map RoutineTaskRow columns onto RoutineTask fields', async () => {
    const limit = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'routine-a',
          user_id: 'user-1',
          title: '晨间回顾',
          max_times_per_day: 3,
          is_enabled: false,
          updated_at: '2026-06-16T01:00:00.000Z',
        },
        {
          id: 'routine-b',
          user_id: 'user-1',
          title: '收件箱清零',
          max_times_per_day: 1,
          is_enabled: true,
          updated_at: '2026-06-15T01:00:00.000Z',
        },
      ],
      error: null,
    });
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      limit,
    };
    mockClient.from.mockReturnValue(query);

    const result = await service.listRoutineTasks('user-1');

    expect(mockClient.from).toHaveBeenCalledWith('routine_tasks');
    expect(query.select).toHaveBeenCalledWith('id,user_id,title,max_times_per_day,is_enabled,updated_at');
    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(query.order).toHaveBeenNthCalledWith(1, 'updated_at', { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 行到模型的字段映射：snake_case 列名转 camelCase，triggerCondition 固定为 any-blank-period
      expect(result.value).toEqual([
        {
          routineId: 'routine-a',
          title: '晨间回顾',
          triggerCondition: 'any-blank-period',
          maxTimesPerDay: 3,
          isEnabled: false,
          updatedAt: '2026-06-16T01:00:00.000Z',
        },
        {
          routineId: 'routine-b',
          title: '收件箱清零',
          triggerCondition: 'any-blank-period',
          maxTimesPerDay: 1,
          isEnabled: true,
          updatedAt: '2026-06-15T01:00:00.000Z',
        },
      ]);
    }
  });

  it('listRoutineTasks should return success([]) offline so callers keep local routines', async () => {
    mockSupabaseClientService.isConfigured = false;

    const result = await service.listRoutineTasks('user-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('listRoutineTasks should fail with FOCUS_CONSOLE_ROUTINE_FAILED when Supabase errors', async () => {
    const range = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'permission denied', code: '42501' },
    });
    const order = vi.fn(() => ({ range }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    mockClient.from.mockReturnValue({ select });

    const result = await service.listRoutineTasks('user-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOCUS_CONSOLE_ROUTINE_FAILED');
    }
  });

  it('upsertRoutineTask should fail when the Sync RPC does not apply the payload', async () => {
    mockSyncRpc.upsertRoutineTask.mockResolvedValueOnce({
      status: 'unauthorized',
      reason: 'jwt-expired',
      raw: {},
    });

    const result = await service.upsertRoutineTask('user-1', createRoutineTask(), 'op-routine-unauthorized');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOCUS_CONSOLE_ROUTINE_FAILED');
    }
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('upsertRoutineTask should fail with FOCUS_CONSOLE_ROUTINE_FAILED when the Sync RPC rejects', async () => {
    mockSyncRpc.upsertRoutineTask.mockRejectedValueOnce(new Error('rpc transport failed'));

    const result = await service.upsertRoutineTask('user-1', createRoutineTask(), 'op-routine-transport');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOCUS_CONSOLE_ROUTINE_FAILED');
    }
  });

  it('upsertRoutineTask should treat idempotent-replay as success without double-writing', async () => {
    mockSyncRpc.upsertRoutineTask.mockResolvedValueOnce({
      status: 'idempotent-replay',
      serverUpdatedAt: '2026-06-15T05:00:00.000Z',
      raw: {},
    });

    const result = await service.upsertRoutineTask('user-1', createRoutineTask(), 'op-routine-replay');

    // RetryQueue 重放同一 operationId 时幂等命中也算成功，避免重复排队
    expect(result.ok).toBe(true);
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('saveFocusSession should succeed on the applied path and never touch legacy REST', async () => {
    mockSyncRpc.upsertFocusSession.mockResolvedValueOnce({
      status: 'applied',
      serverUpdatedAt: '2026-03-03T02:00:00.000Z',
      raw: {},
    });
    const record = createFocusSessionRecord();

    const result = await service.saveFocusSession(record, 'op-focus-success');

    expect(result.ok).toBe(true);
    expect(mockSyncRpc.upsertFocusSession).toHaveBeenCalledWith({
      operationId: 'op-focus-success',
      record,
    });
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('saveFocusSession should treat idempotent-replay as success', async () => {
    mockSyncRpc.upsertFocusSession.mockResolvedValueOnce({
      status: 'idempotent-replay',
      raw: {},
    });

    const result = await service.saveFocusSession(createFocusSessionRecord(), 'op-focus-replay');

    expect(result.ok).toBe(true);
  });

  it('incrementRoutineCompletion should defer to the retry queue when the Sync RPC feature is disabled', async () => {
    mockSyncRpc.isFeatureEnabled.mockReturnValue(false);

    const result = await service.incrementRoutineCompletion({
      completionId: 'comp-1',
      userId: 'user-1',
      routineId: 'routine-1',
      dateKey: '2026-03-03',
    }, 'op-completion-disabled');

    // retry-queue 协同：RPC 不可用时不得 legacy 直写，返回 deferred+retryable
    // 让已持久化的队列稍后重放同一 operationId
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOCUS_CONSOLE_INCREMENT_FAILED');
      expect(result.error.details?.['reason']).toBe('sync-rpc-unavailable');
      expect(result.error.details?.['retryable']).toBe(true);
      expect(result.error.details?.['deferred']).toBe(true);
      expect(result.error.details?.['operationId']).toBe('op-completion-disabled');
    }
    expect(mockSyncRpc.incrementRoutineCompletion).not.toHaveBeenCalled();
    expect(mockClient.rpc).not.toHaveBeenCalled();
  });

  it('incrementRoutineCompletion should defer to the retry queue when the client protocol is rejected', async () => {
    mockSyncRpc.isClientRejected.mockReturnValue(true);

    const result = await service.incrementRoutineCompletion({
      completionId: 'comp-1',
      userId: 'user-1',
      routineId: 'routine-1',
      dateKey: '2026-03-03',
    }, 'op-completion-rejected');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.['reason']).toBe('sync-rpc-unavailable');
      expect(result.error.details?.['clientRejected']).toBe(true);
    }
    expect(mockSyncRpc.incrementRoutineCompletion).not.toHaveBeenCalled();
    expect(mockClient.rpc).not.toHaveBeenCalled();
  });

  it('incrementRoutineCompletion should treat idempotent-replay as success so queue replays never double count', async () => {
    mockSyncRpc.incrementRoutineCompletion.mockResolvedValueOnce({
      status: 'idempotent-replay',
      raw: {},
    });

    const result = await service.incrementRoutineCompletion({
      completionId: 'comp-replay',
      userId: 'user-1',
      routineId: 'routine-1',
      dateKey: '2026-03-03',
    }, 'op-completion-replay');

    expect(result.ok).toBe(true);
    expect(mockClient.rpc).not.toHaveBeenCalled();
  });

  it('incrementRoutineCompletion should fail without retry side effects when the RPC is not applied', async () => {
    mockSyncRpc.incrementRoutineCompletion.mockResolvedValueOnce({
      status: 'unauthorized',
      reason: 'jwt-expired',
      raw: {},
    });

    const result = await service.incrementRoutineCompletion({
      completionId: 'comp-unauthorized',
      userId: 'user-1',
      routineId: 'routine-1',
      dateKey: '2026-03-03',
    }, 'op-completion-unauthorized');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOCUS_CONSOLE_INCREMENT_FAILED');
    }
    expect(mockClient.rpc).not.toHaveBeenCalled();
  });
});
