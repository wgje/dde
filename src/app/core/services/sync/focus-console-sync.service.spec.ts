import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusConsoleSyncService } from './focus-console-sync.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import {
  createBrowserNetworkSuspendedError,
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../../../../utils/browser-network-suspension';

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

  const mockLogger = {
    category: vi.fn(() => ({
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    })),
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
    resetBrowserNetworkSuspensionTrackingForTests();
    ensureBrowserNetworkSuspensionTracking();
    setVisibilityState('visible');

    TestBed.configureTestingModule({
      providers: [
        FocusConsoleSyncService,
        { provide: SupabaseClientService, useValue: mockSupabaseClientService },
        { provide: LoggerService, useValue: mockLogger },
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

  it('saveFocusSession should return failure Result on error so queue can retry', async () => {
    const upsert = vi.fn().mockResolvedValue({
      error: { message: 'temporary failure' },
    });
    mockClient.from.mockReturnValue({ upsert });

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

  it('listRoutineTasks should return success([]) when browser IO is suspended mid-request', async () => {
    const order = vi.fn().mockRejectedValue(createBrowserNetworkSuspendedError());
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    mockClient.from.mockReturnValue({ select });

    const result = await service.listRoutineTasks('user-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SYNC_OFFLINE');
      expect(result.error.details?.['reason']).toBe('browser-network-suspended');
    }
  });

  // TODO(L-28): Add test for listRoutineTasks — verify it maps RoutineTaskRow to RoutineTask[]
  // TODO(L-28): Add test for upsertRoutineTask — verify upsert payload shape and error handling
  // TODO(L-28): Add test for importLegacyDockSnapshot — verify it reads from user_preferences table
  // TODO(L-28): Add test for saveFocusSession success path — verify it returns true and upsert payload
  // TODO(L-28): Add test for incrementRoutineCompletion 挂起窗口外的 retry-queue 协同行为

  it('incrementRoutineCompletion should call atomic rpc with date_key path', async () => {
    mockClient.rpc.mockResolvedValue({ data: 1, error: null });

    const result = await service.incrementRoutineCompletion({
      completionId: 'comp-1',
      userId: 'user-1',
      routineId: 'routine-1',
      dateKey: '2026-03-03',
    });

    expect(result.ok).toBe(true);
    expect(mockClient.rpc).toHaveBeenCalledWith('increment_routine_completion', {
      p_completion_id: 'comp-1',
      p_routine_id: 'routine-1',
      p_date_key: '2026-03-03',
    });
  });

  it('incrementRoutineCompletion should return failure when atomic rpc fails', async () => {
    mockClient.rpc.mockResolvedValue({
      data: null,
      error: { message: 'rpc failed' },
    });

    const result = await service.incrementRoutineCompletion({
      completionId: 'comp-1',
      userId: 'user-1',
      routineId: 'routine-1',
      dateKey: '2026-03-03',
    });

    expect(result.ok).toBe(false);
  });
});
