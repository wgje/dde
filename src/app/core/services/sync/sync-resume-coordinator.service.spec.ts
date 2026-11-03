import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SessionRuntimeResetRegistry } from '../../../../services/session-runtime-reset.service';
import { SyncCoordinatorProjectRefreshService } from '../../../../services/sync-coordinator-project-refresh.service';
import { FEATURE_FLAGS } from '../../../../config/feature-flags.config';
import { ConnectivityRecoveryService } from './connectivity-recovery.service';
import { RealtimePollingService } from './realtime-polling.service';
import { RetryQueueService } from './retry-queue.service';
import { SessionManagerService } from './session-manager.service';
import { SyncResumeCoordinatorService } from './sync-resume-coordinator.service';
import { SyncStateService } from './sync-state.service';
import {
  SyncResumeRetryContinuationController,
  type SyncResumeRetryContinuationDeps,
} from './sync-resume-retry-continuation.controller';

type RetryQueueSliceResult = {
  processed: number;
  remaining: number;
  durationMs: number;
  completed: boolean;
};

function createDeps(
  processQueueSlice: SyncResumeRetryContinuationDeps['processQueueSlice'] =
    vi.fn().mockResolvedValue({
      processed: 1,
      remaining: 0,
      durationMs: 10,
      completed: true,
    } satisfies RetryQueueSliceResult),
): SyncResumeRetryContinuationDeps {
  return {
    addBreadcrumb: vi.fn(),
    logger: {
      warn: vi.fn(),
    },
    processQueueSlice,
    scheduleRetryContinuation: vi.fn(),
  };
}

describe('SyncResumeCoordinatorService recoverAfterResume newest-wins', () => {
  let service: SyncResumeCoordinatorService;

  const mockCategoryLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockSyncState = {
    update: vi.fn(),
    syncState: vi.fn(() => ({ isOnline: true })),
  };

  const mockSentry = {
    addBreadcrumb: vi.fn(),
  };

  const mockSessionManager = {
    getRecentValidationSnapshot: vi.fn(() => null),
    validateOrRefreshOnResume: vi.fn().mockResolvedValue({ ok: true, deferred: false }),
    validateSession: vi.fn().mockResolvedValue({ valid: true, userId: 'user-1' }),
  };

  const mockConnectivityRecovery = {
    cancelScheduledRecovery: vi.fn(),
    scheduleConnectivityRecovery: vi.fn(),
    probeRemoteReachability: vi.fn().mockResolvedValue(true),
    flushPendingConnectivityRecovery: vi.fn(),
    flushAttachmentCleanupOutboxAfterResume: vi.fn().mockResolvedValue(undefined),
  };

  const mockRetryQueue = {
    length: 0,
    processQueueSlice: vi.fn().mockResolvedValue({
      processed: 0,
      remaining: 0,
      durationMs: 0,
      completed: true,
    }),
  };

  const mockRealtimePolling = {
    resumeTransport: vi.fn().mockResolvedValue(undefined),
    resumeRealtimeUpdates: vi.fn(),
    hasRemoteChangeCallback: vi.fn(() => true),
    getCurrentProjectId: vi.fn(() => 'project-1'),
    triggerRemoteChange: vi.fn().mockResolvedValue(true),
  };

  const mockProjectRefresh = {
    downloadAndMerge: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionManager.validateOrRefreshOnResume.mockResolvedValue({ ok: true, deferred: false });
    mockConnectivityRecovery.probeRemoteReachability.mockResolvedValue(true);
    mockConnectivityRecovery.flushAttachmentCleanupOutboxAfterResume.mockReset();
    mockConnectivityRecovery.flushAttachmentCleanupOutboxAfterResume.mockResolvedValue(undefined);
    mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
    mockRealtimePolling.triggerRemoteChange.mockResolvedValue(true);

    TestBed.configureTestingModule({
      providers: [
        SyncResumeCoordinatorService,
        { provide: LoggerService, useValue: { category: () => mockCategoryLogger } },
        { provide: SyncStateService, useValue: mockSyncState },
        { provide: SentryLazyLoaderService, useValue: mockSentry },
        { provide: SessionManagerService, useValue: mockSessionManager },
        { provide: ConnectivityRecoveryService, useValue: mockConnectivityRecovery },
        { provide: RetryQueueService, useValue: mockRetryQueue },
        { provide: RealtimePollingService, useValue: mockRealtimePolling },
        { provide: SyncCoordinatorProjectRefreshService, useValue: mockProjectRefresh },
      ],
    });

    service = TestBed.inject(SyncResumeCoordinatorService);
  });

  afterEach(() => {
    service.cancelPendingBackgroundRecovery();
    TestBed.resetTestingModule();
  });

  it('旧恢复在新 recoverAfterResume 启动后应在阶段边界让位，不再恢复 transport 或触发远端探测', async () => {
    let releaseFirstSession!: (value: { ok: boolean; deferred: boolean }) => void;
    mockSessionManager.validateOrRefreshOnResume
      .mockImplementationOnce(() => new Promise(resolve => {
        releaseFirstSession = resolve;
      }))
      .mockResolvedValueOnce({ ok: true, deferred: false });

    const firstRecovery = service.recoverAfterResume('visibility-threshold', { mode: 'heavy' });
    const secondRecovery = service.recoverAfterResume('online', { mode: 'heavy' });
    await secondRecovery;

    expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
    expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);

    releaseFirstSession({ ok: true, deferred: false });
    await firstRecovery;

    // 旧恢复被取代后不得再次恢复 transport、探测远端或触发全量云端加载
    expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
    expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
    expect(mockProjectRefresh.downloadAndMerge).not.toHaveBeenCalled();
    expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        step: 'recovery-superseded-by-newer-flight',
        phase: 'session-gate',
        reason: 'visibility-threshold',
      }),
    }));
  });

  it('owner reset should invalidate a recovery waiting at the session gate', async () => {
    let releaseSession!: (value: { ok: boolean; deferred: boolean }) => void;
    mockSessionManager.validateOrRefreshOnResume.mockImplementationOnce(
      () => new Promise(resolve => {
        releaseSession = resolve;
      }),
    );

    const recovery = service.recoverAfterResume('visibility-threshold', { mode: 'heavy' });
    await vi.waitFor(() => {
      expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledOnce();
    });

    const resetResult = TestBed.inject(SessionRuntimeResetRegistry).resetAll('owner-change');
    releaseSession({ ok: true, deferred: false });
    await recovery;

    expect(resetResult.attemptedOwners).toContain('SyncResumeCoordinatorService');
    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
    expect(mockRealtimePolling.triggerRemoteChange).not.toHaveBeenCalled();
    expect(mockProjectRefresh.downloadAndMerge).not.toHaveBeenCalled();
    expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        step: 'recovery-superseded-by-newer-flight',
        phase: 'session-gate',
        reason: 'visibility-threshold',
      }),
    }));
  });

  it('owner reset after a timed-out remote probe must not schedule a stale fallback', async () => {
    let releaseProbe!: (value: boolean) => void;
    mockRealtimePolling.triggerRemoteChange.mockImplementationOnce(
      () => new Promise<boolean>(resolve => {
        releaseProbe = resolve;
      }),
    );
    const backgroundTasks = (service as unknown as {
      backgroundTasks: { scheduleRemoteProbeFallback: (...args: unknown[]) => void };
    }).backgroundTasks;
    const scheduleFallback = vi.spyOn(backgroundTasks, 'scheduleRemoteProbeFallback');

    const recovery = service.recoverAfterResume('visibility-threshold', {
      mode: 'heavy',
      resumeProbeTimeoutMs: 20,
      backgroundProbeDelayMs: 10,
    });
    await vi.waitFor(() => expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1));

    TestBed.inject(SessionRuntimeResetRegistry).resetAll('owner-change');
    await recovery;

    expect(scheduleFallback).not.toHaveBeenCalled();
    releaseProbe(false);
    await Promise.resolve();
  });

  it('单个恢复流程不受 newest-wins 影响，完整执行 transport 恢复与远端探测', async () => {
    await service.recoverAfterResume('visibility-threshold', { mode: 'heavy' });

    expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
    expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
    expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ step: 'sync-recovery-complete' }),
    }));
  });

  it('heavy resume should flush attachment cleanup once after realtime resume without waiting for connectivity change', async () => {
    const callOrder: string[] = [];
    mockRealtimePolling.resumeTransport.mockImplementation(async () => {
      callOrder.push('resumeTransport');
    });
    mockRealtimePolling.resumeRealtimeUpdates.mockImplementation(() => {
      callOrder.push('resumeRealtimeUpdates');
    });
    mockConnectivityRecovery.flushAttachmentCleanupOutboxAfterResume.mockImplementation(async () => {
      callOrder.push('flushAttachmentCleanup');
    });
    mockRealtimePolling.triggerRemoteChange.mockImplementation(async () => {
      callOrder.push('triggerRemoteChange');
      return true;
    });

    await service.recoverAfterResume('visibility-threshold', { mode: 'heavy' });

    expect(mockConnectivityRecovery.flushAttachmentCleanupOutboxAfterResume).toHaveBeenCalledTimes(1);
    expect(mockConnectivityRecovery.flushAttachmentCleanupOutboxAfterResume).toHaveBeenCalledWith(
      'visibility-threshold',
      expect.any(Function),
    );
    expect(callOrder).toEqual([
      'resumeTransport',
      'resumeRealtimeUpdates',
      'flushAttachmentCleanup',
      'triggerRemoteChange',
    ]);
  });

  it('a superseded resume flight must not flush attachment cleanup from the stale recovery', async () => {
    let releaseFirstTransport!: () => void;
    mockRealtimePolling.resumeTransport
      .mockImplementationOnce(() => new Promise<void>(resolve => {
        releaseFirstTransport = resolve;
      }))
      .mockResolvedValueOnce(undefined);

    const firstRecovery = service.recoverAfterResume('visibility-threshold', { mode: 'heavy' });
    await vi.waitFor(() => {
      expect(releaseFirstTransport).toBeTypeOf('function');
    });

    await service.recoverAfterResume('online', { mode: 'heavy' });
    releaseFirstTransport();
    await firstRecovery;

    expect(mockConnectivityRecovery.flushAttachmentCleanupOutboxAfterResume).toHaveBeenCalledTimes(1);
    expect(mockConnectivityRecovery.flushAttachmentCleanupOutboxAfterResume).toHaveBeenCalledWith(
      'online',
      expect.any(Function),
    );
  });

  it('Sentry breadcrumb 抛错不得中断恢复流程或外泄拒绝（观测失败必须被隔离）', async () => {
    mockSentry.addBreadcrumb.mockImplementation(() => {
      throw new Error('sentry beforeBreadcrumb hook failed');
    });

    try {
      await expect(service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        recoveryTicketId: 'ticket-breadcrumb-throw',
      })).resolves.toBeUndefined();

      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
    } finally {
      mockSentry.addBreadcrumb.mockReset();
    }
  });

  it('首次探测 await 期间被更新的 heavy 恢复取代后，老恢复不得补发重试探测', async () => {
    let resolveFirstProbe!: (triggered: boolean) => void;
    mockRealtimePolling.triggerRemoteChange
      .mockImplementationOnce(() => new Promise<boolean>(resolve => {
        resolveFirstProbe = resolve;
      }))
      .mockResolvedValueOnce(true);

    const firstRecovery = service.recoverAfterResume('visibility-threshold', { mode: 'heavy' });
    await vi.waitFor(() => {
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
    });

    await service.recoverAfterResume('online', { mode: 'heavy' });
    expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);

    // 首次探测返回"未触发且未超时"：老恢复的重试补发必须被代际守卫拦下
    resolveFirstProbe(false);
    await firstRecovery;

    expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
  });

  it('interaction-first disabled fallback should download and merge remote projects into state', async () => {
    const mutableFlags = FEATURE_FLAGS as unknown as { RESUME_INTERACTION_FIRST_V1: boolean };
    const originalFlag = mutableFlags.RESUME_INTERACTION_FIRST_V1;
    Object.defineProperty(mutableFlags, 'RESUME_INTERACTION_FIRST_V1', {
      configurable: true,
      value: false,
    });
    mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(false);
    mockRealtimePolling.triggerRemoteChange.mockResolvedValue(false);

    try {
      await service.recoverAfterResume('visibility-threshold', { mode: 'heavy' });

      expect(mockSessionManager.validateSession).toHaveBeenCalled();
      expect(mockProjectRefresh.downloadAndMerge).toHaveBeenCalledWith('user-1');
    } finally {
      Object.defineProperty(mutableFlags, 'RESUME_INTERACTION_FIRST_V1', {
        configurable: true,
        value: originalFlag,
      });
    }
  });
});

describe('SyncResumeRetryContinuationController', () => {
  it('ignores a stale retry queue continuation result after a newer recovery generation wins', () => {
    const deps = createDeps();
    const controller = new SyncResumeRetryContinuationController(deps);
    const options = controller.createContinuationOptions({
      reason: 'visibility-threshold',
      mode: 'light',
      retrySlice: 30,
      maxDurationMs: 150,
      maxRounds: 5,
      round: 1,
    });

    controller.cancelPendingContinuations();
    controller.handleRetryQueueContinuationResult(options, {
      processed: 1,
      remaining: 5,
      durationMs: 120,
      completed: false,
    });

    expect(deps.scheduleRetryContinuation).not.toHaveBeenCalled();
    expect(deps.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('ignores a stale retry queue continuation error after a newer recovery generation wins', () => {
    const deps = createDeps();
    const controller = new SyncResumeRetryContinuationController(deps);
    const options = controller.createContinuationOptions({
      reason: 'visibility-threshold',
      mode: 'light',
      retrySlice: 30,
      maxDurationMs: 150,
      maxRounds: 5,
      round: 1,
    });

    controller.cancelPendingContinuations();
    controller.handleRetryQueueContinuationError(options, new Error('slice failed'));

    expect(deps.scheduleRetryContinuation).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('schedules a continuation when the first background retry slice is incomplete', async () => {
    const deps = createDeps(vi.fn().mockResolvedValue({
      processed: 30,
      remaining: 2,
      durationMs: 140,
      completed: false,
    } satisfies RetryQueueSliceResult));
    const controller = new SyncResumeRetryContinuationController(deps);

    await controller.processFirstBackgroundRetrySlice({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 30,
      maxDurationMs: 150,
      maxRounds: 5,
    });

    expect(deps.processQueueSlice).toHaveBeenCalledWith({
      maxItems: 30,
      maxDurationMs: 150,
    });
    expect(deps.scheduleRetryContinuation).toHaveBeenCalledWith(
      expect.any(Function),
      200,
    );
  });

  it('does not schedule a continuation when the first background retry slice leaves no remaining work', async () => {
    const deps = createDeps(vi.fn().mockResolvedValue({
      processed: 1,
      remaining: 0,
      durationMs: 40,
      completed: false,
    } satisfies RetryQueueSliceResult));
    const controller = new SyncResumeRetryContinuationController(deps);

    await controller.processFirstBackgroundRetrySlice({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 30,
      maxDurationMs: 150,
      maxRounds: 5,
    });

    expect(deps.scheduleRetryContinuation).not.toHaveBeenCalled();
  });

  it('warns and schedules a continuation when the first background retry slice fails', async () => {
    const error = new Error('first slice failed');
    const deps = createDeps(vi.fn().mockRejectedValue(error));
    const controller = new SyncResumeRetryContinuationController(deps);

    await controller.processFirstBackgroundRetrySlice({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 30,
      maxDurationMs: 150,
      maxRounds: 5,
    });

    expect(deps.logger.warn).toHaveBeenCalledWith(
      '恢复链路后台首个重试切片失败',
      { reason: 'online', mode: 'heavy', error },
    );
    expect(deps.scheduleRetryContinuation).toHaveBeenCalledWith(
      expect.any(Function),
      200,
    );
  });

  it('warns and continues when a later background retry slice throws synchronously', async () => {
    const error = new Error('later slice failed synchronously');
    const processQueueSlice = vi.fn()
      .mockResolvedValueOnce({
        processed: 30,
        remaining: 2,
        durationMs: 140,
        completed: false,
      } satisfies RetryQueueSliceResult)
      .mockImplementationOnce(() => {
        throw error;
      });
    const deps = createDeps(processQueueSlice);
    const controller = new SyncResumeRetryContinuationController(deps);

    await controller.processFirstBackgroundRetrySlice({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 30,
      maxDurationMs: 150,
      maxRounds: 5,
    });

    const runSlice = vi.mocked(deps.scheduleRetryContinuation).mock.calls[0]?.[0];
    expect(runSlice).toBeTypeOf('function');

    expect(() => runSlice()).not.toThrow();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      '恢复链路后台重试切片失败',
      { reason: 'online', mode: 'heavy', error },
    );
    expect(deps.scheduleRetryContinuation).toHaveBeenCalledTimes(2);
    expect(deps.scheduleRetryContinuation).toHaveBeenLastCalledWith(
      expect.any(Function),
      500,
    );
  });
});
